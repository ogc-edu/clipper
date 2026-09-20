import { InvalidUploadKeyError } from "./errors.js";

/** First path segment of every upload object key. */
export const UPLOAD_PREFIX = "uploads";
/** Final path segment of every upload object key. */
export const SOURCE_FILENAME = "source";
/** First path segment of every processed-output object key. */
export const OUTPUTS_PREFIX = "outputs";
/** Directory holding the HLS renditions for a video. */
export const HLS_DIRECTORY = "hls";
/** Filename of the generated poster image. */
export const THUMBNAIL_FILENAME = "thumb.jpg";

/**
 * The nil UUID is a valid RFC-4122 UUID even though it has no version or
 * variant bits set.
 */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Matches any RFC-4122 UUID (versions 1–8, RFC variant), not just v4.
 * See https://datatracker.ietf.org/doc/html/rfc4122#section-4.1.1.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a syntactically valid RFC-4122 UUID. */
export function isUuid(value: string): boolean {
  return value.toLowerCase() === NIL_UUID || UUID_PATTERN.test(value);
}

/**
 * Builds the canonical upload object key for a video:
 * `uploads/{ownerSub}/{videoId}/source`.
 *
 * This is a pure builder — use {@link parseUploadKey} to validate keys.
 */
export function uploadKey(ownerSub: string, videoId: string): string {
  return `${UPLOAD_PREFIX}/${ownerSub}/${videoId}/${SOURCE_FILENAME}`;
}

/** The business fields encoded in an upload object key. */
export interface ParsedUploadKey {
  ownerSub: string;
  videoId: string;
}

/**
 * Parses an upload object key, enforcing the exact convention
 * `uploads/{ownerSub}/{videoId}/source`.
 *
 * @throws {InvalidUploadKeyError} when the key has the wrong prefix, a
 * missing or extra segment, an empty `ownerSub`, or a non-UUID `videoId`.
 */
export function parseUploadKey(key: string): ParsedUploadKey {
  const segments = key.split("/");
  if (segments.length !== 4) {
    throw new InvalidUploadKeyError(
      key,
      `expected 4 path segments, found ${segments.length}`,
    );
  }

  const [prefix, ownerSub, videoId, filename] = segments as [
    string,
    string,
    string,
    string,
  ];

  if (prefix !== UPLOAD_PREFIX) {
    throw new InvalidUploadKeyError(
      key,
      `expected prefix "${UPLOAD_PREFIX}", found "${prefix}"`,
    );
  }
  if (ownerSub.length === 0) {
    throw new InvalidUploadKeyError(key, "ownerSub segment is empty");
  }
  if (!isUuid(videoId)) {
    throw new InvalidUploadKeyError(
      key,
      `videoId "${videoId}" is not a valid RFC-4122 UUID`,
    );
  }
  if (filename !== SOURCE_FILENAME) {
    throw new InvalidUploadKeyError(
      key,
      `expected final segment "${SOURCE_FILENAME}", found "${filename}"`,
    );
  }

  return { ownerSub, videoId };
}

/** Builds the HLS output prefix for a video: `outputs/{videoId}/hls/`. */
export function outputHlsPrefix(videoId: string): string {
  return `${OUTPUTS_PREFIX}/${videoId}/${HLS_DIRECTORY}/`;
}

/** Builds the thumbnail output key for a video: `outputs/{videoId}/thumb.jpg`. */
export function outputThumbnailKey(videoId: string): string {
  return `${OUTPUTS_PREFIX}/${videoId}/${THUMBNAIL_FILENAME}`;
}
