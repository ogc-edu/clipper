/**
 * Domain types shared by the web app and the workers.
 *
 * These mirror the database enums in `docs/ARCHITECTURE.md` §2.3 and the
 * message contract in §2.4. They are intentionally plain string unions so
 * they can be consumed without a runtime dependency.
 */

export const VIDEO_STATES = [
  "UPLOADING",
  "QUEUED",
  "PROCESSING",
  "READY",
  "FAILED",
] as const;

/** Lifecycle state of a video record. */
export type VideoState = (typeof VIDEO_STATES)[number];

export const JOB_KINDS = ["TRANSCODE", "THUMBNAIL"] as const;

/** The independent processing jobs a video goes through. */
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = ["PENDING", "RUNNING", "DONE", "FAILED"] as const;

/** State of a single `(video, job kind)` pair. */
export type JobState = (typeof JOB_STATES)[number];

/**
 * The business payload every worker derives from an S3 `ObjectCreated`
 * event. Mirrors the contract documented in `docs/ARCHITECTURE.md` §2.4.
 */
export interface ParsedUploadEvent {
  /** UUID of the video record. */
  videoId: string;
  /** Cognito `sub` of the owning user. */
  ownerSub: string;
  /** Canonical upload object key: `uploads/{ownerSub}/{videoId}/source`. */
  uploadKey: string;
  /** Name of the uploads bucket the event originated from. */
  bucket: string;
  /** Stable-ish identifier for the originating S3 event. */
  eventId: string;
}
