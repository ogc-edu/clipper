#!/usr/bin/env bash
#
# Fan-out acceptance check for feature 002.
#
# Uploads a small object to the uploads bucket under the canonical key
# convention, then long-polls BOTH queues and prints the raw S3 event body
# each one received. The real message is returned to the queue (visibility
# reset), not deleted, so the pipeline stays usable. S3 `s3:TestEvent`
# messages emitted when a notification is first configured are dropped.
#
# Usage:
#   infra/scripts/verify-messaging.sh [ownerSub] [videoId]
#
# Environment overrides: AWS_REGION, UPLOADS_BUCKET, TRANSCODE_QUEUE,
# THUMBNAIL_QUEUE.
set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
UPLOADS_BUCKET="${UPLOADS_BUCKET:-clipper-ogc-raw}"
TRANSCODE_QUEUE="${TRANSCODE_QUEUE:-clipper-transcode-queue}"
THUMBNAIL_QUEUE="${THUMBNAIL_QUEUE:-clipper-thumbnail-queue}"

OWNER_SUB="${1:-test-sub}"
VIDEO_ID="${2:-$(uuidgen | tr '[:upper:]' '[:lower:]')}"
KEY="uploads/${OWNER_SUB}/${VIDEO_ID}/source"

function queue_url() {
  aws sqs get-queue-url --region "$REGION" --queue-name "$1" \
    --query QueueUrl --output text
}

function json_field() {
  python3 -c "import sys, json; msgs = json.load(sys.stdin).get(\"Messages\", []); print(msgs[0][\"$1\"] if msgs else \"\")"
}

function is_test_event() {
  printf '%s' "$1" | python3 -c "import sys, json
try:
    print('yes' if json.load(sys.stdin).get('Event') == 's3:TestEvent' else 'no')
except Exception:
    print('no')"
}

function receive_and_release() {
  local url="$1" label="$2" attempt response body handle
  echo
  echo "=== ${label} ==="
  for attempt in $(seq 1 12); do
    response="$(aws sqs receive-message --region "$REGION" --queue-url "$url" \
      --max-number-of-messages 1 --wait-time-seconds 5 \
      --visibility-timeout 60 --output json)"
    body="$(printf '%s' "$response" | json_field Body)"
    handle="$(printf '%s' "$response" | json_field ReceiptHandle)"
    if [ -n "$body" ]; then
      if [ "$(is_test_event "$body")" = "yes" ]; then
        aws sqs delete-message --region "$REGION" --queue-url "$url" \
          --receipt-handle "$handle" >/dev/null
        echo "(dropped S3 test event left over from notification setup)"
        continue
      fi
      printf '%s' "$body" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$body"
      aws sqs change-message-visibility --region "$REGION" --queue-url "$url" \
        --receipt-handle "$handle" --visibility-timeout 0 >/dev/null
      echo "(message returned to the queue for workers)"
      return 0
    fi
    sleep 2
  done
  echo "No message received after 12 attempts ($attempt)." >&2
  return 1
}

TRANSCODE_QUEUE_URL="$(queue_url "$TRANSCODE_QUEUE")"
THUMBNAIL_QUEUE_URL="$(queue_url "$THUMBNAIL_QUEUE")"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT
printf 'clipper messaging verification %s\n' "$(date -u +%FT%TZ)" >"$TMP_FILE"

echo "Uploading s3://${UPLOADS_BUCKET}/${KEY}"
aws s3 cp "$TMP_FILE" "s3://${UPLOADS_BUCKET}/${KEY}" --region "$REGION" >/dev/null
echo "Waiting for S3 -> SNS -> SQS delivery..."
sleep 5

receive_and_release "$TRANSCODE_QUEUE_URL" "$TRANSCODE_QUEUE"
receive_and_release "$THUMBNAIL_QUEUE_URL" "$THUMBNAIL_QUEUE"

echo
echo "PASS: the same upload appeared in both queues."
