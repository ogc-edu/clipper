/**
 * Typed errors thrown by the shared key-convention and S3-event helpers.
 *
 * Workers catch these specifically: an `InvalidUploadKeyError` means the
 * message can never succeed and belongs in the DLQ, whereas an
 * `S3EventParseError` means the payload was malformed.
 */

/** Machine-readable discriminant for {@link InvalidUploadKeyError}. */
export const INVALID_UPLOAD_KEY_CODE = "INVALID_UPLOAD_KEY";

/**
 * Thrown when an S3 object key does not follow the Clipper upload key
 * convention `uploads/{ownerSub}/{videoId}/source`.
 */
export class InvalidUploadKeyError extends Error {
  readonly code = INVALID_UPLOAD_KEY_CODE;
  /** The offending key. */
  readonly key: string;
  /** Why the key was rejected. */
  readonly reason: string;

  constructor(key: string, reason: string) {
    super(`Invalid upload key "${key}": ${reason}`);
    this.name = "InvalidUploadKeyError";
    this.key = key;
    this.reason = reason;
  }
}

/** Machine-readable discriminant for {@link S3EventParseError}. */
export const S3_EVENT_PARSE_ERROR_CODE = "S3_EVENT_PARSE_ERROR";

/**
 * Thrown when a raw S3 `ObjectCreated` event delivered through SNS → SQS
 * cannot be parsed. This includes malformed JSON, S3 `s3:TestEvent`
 * payloads, and structurally invalid event notifications.
 */
export class S3EventParseError extends Error {
  readonly code = S3_EVENT_PARSE_ERROR_CODE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "S3EventParseError";
  }
}
