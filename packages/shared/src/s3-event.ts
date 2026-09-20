import { S3EventParseError } from "./errors.js";
import { parseUploadKey, uploadKey } from "./keys.js";
import type { ParsedUploadEvent } from "./types.js";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new S3EventParseError(
      `S3 event is missing or has a malformed \`${label}\` object`,
    );
  }
  return value;
}

/**
 * S3 URL-encodes object keys in event notifications. `%XX` escapes are
 * percent-decoded and `+` represents a literal space.
 */
function decodeS3ObjectKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, "%20"));
  } catch (cause) {
    throw new S3EventParseError(
      `S3 object key is not valid URL encoding: "${key}"`,
      { cause },
    );
  }
}

/**
 * Parses the raw S3 `ObjectCreated` event that S3 delivers to SNS and SNS
 * forwards to SQS with raw message delivery (see `docs/ARCHITECTURE.md`
 * decision D1). The key is decoded and validated against the upload key
 * convention before the business fields are returned.
 *
 * @throws {S3EventParseError} for malformed JSON, S3 test events, or
 * structurally invalid event notifications.
 * @throws {InvalidUploadKeyError} when the object key is off-convention.
 */
export function parseS3EventFromSqs(body: string): ParsedUploadEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new S3EventParseError("SQS message body is not valid JSON", {
      cause,
    });
  }

  const event = asRecord(parsed, "message body");

  // S3 sends this when the bucket notification configuration is created.
  if (event.Event === "s3:TestEvent") {
    throw new S3EventParseError(
      "Received an S3 test event (s3:TestEvent) instead of an ObjectCreated event",
    );
  }

  const records = event.Records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new S3EventParseError("S3 event has no non-empty `Records` array");
  }
  const record = asRecord(records[0], "Records[0]");

  const eventName = record.eventName;
  if (typeof eventName !== "string" || !eventName.startsWith("ObjectCreated")) {
    throw new S3EventParseError(
      `Unsupported S3 event name: "${String(eventName)}" (expected ObjectCreated:*)`,
    );
  }

  const s3 = asRecord(record.s3, "Records[0].s3");
  const bucket = asRecord(s3.bucket, "Records[0].s3.bucket");
  const object = asRecord(s3.object, "Records[0].s3.object");

  const bucketName = bucket.name;
  if (typeof bucketName !== "string" || bucketName.length === 0) {
    throw new S3EventParseError(
      "S3 event is missing `Records[0].s3.bucket.name`",
    );
  }

  const rawKey = object.key;
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    throw new S3EventParseError(
      "S3 event is missing `Records[0].s3.object.key`",
    );
  }

  const decodedKey = decodeS3ObjectKey(rawKey);
  const { ownerSub, videoId } = parseUploadKey(decodedKey);

  // S3 event records have no dedicated `eventId`; the S3 request id is the
  // closest stable identifier, with the object sequencer as a fallback.
  const requestId = isRecord(record.responseElements)
    ? record.responseElements["x-amz-request-id"]
    : undefined;
  const sequencer = object.sequencer;
  const eventId =
    typeof requestId === "string" && requestId.length > 0
      ? requestId
      : typeof sequencer === "string"
        ? sequencer
        : "";

  return {
    videoId,
    ownerSub,
    uploadKey: uploadKey(ownerSub, videoId),
    bucket: bucketName,
    eventId,
  };
}
