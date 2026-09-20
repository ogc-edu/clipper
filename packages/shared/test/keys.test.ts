import { describe, expect, it } from "vitest";
import {
  InvalidUploadKeyError,
  isUuid,
  outputHlsPrefix,
  outputThumbnailKey,
  parseUploadKey,
  uploadKey,
} from "../src/index.js";

const OWNER_SUB = "6f1c2f5e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
const VIDEO_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("uploadKey", () => {
  it("builds the canonical upload key", () => {
    expect(uploadKey(OWNER_SUB, VIDEO_ID)).toBe(
      `uploads/${OWNER_SUB}/${VIDEO_ID}/source`,
    );
  });
});

describe("parseUploadKey", () => {
  it("round-trips a built key (build → parse → equal)", () => {
    const key = uploadKey(OWNER_SUB, VIDEO_ID);
    expect(parseUploadKey(key)).toEqual({
      ownerSub: OWNER_SUB,
      videoId: VIDEO_ID,
    });
  });

  it("parses a hand-written key", () => {
    expect(parseUploadKey(`uploads/${OWNER_SUB}/${VIDEO_ID}/source`)).toEqual({
      ownerSub: OWNER_SUB,
      videoId: VIDEO_ID,
    });
  });

  it.each([
    ["the empty string", ""],
    ["a key with no segments", "source"],
    ["a wrong prefix", `videos/${OWNER_SUB}/${VIDEO_ID}/source`],
    ["a singular prefix", `upload/${OWNER_SUB}/${VIDEO_ID}/source`],
    ["a case-sensitive prefix", `Uploads/${OWNER_SUB}/${VIDEO_ID}/source`],
    ["a missing source segment", `uploads/${OWNER_SUB}/${VIDEO_ID}`],
    ["a missing videoId segment", `uploads/${OWNER_SUB}/source`],
    [
      "an extra trailing segment",
      `uploads/${OWNER_SUB}/${VIDEO_ID}/source/extra`,
    ],
    ["an empty ownerSub", `uploads//${VIDEO_ID}/source`],
    ["an empty videoId", `uploads/${OWNER_SUB}//source`],
    ["a non-UUID videoId", `uploads/${OWNER_SUB}/not-a-uuid/source`],
    [
      "a truncated UUID videoId",
      `uploads/${OWNER_SUB}/12345678-1234-1234-1234-12345678901/source`,
    ],
    [
      "a UUID with a version-0 nibble",
      `uploads/${OWNER_SUB}/0f8fad5b-d9cb-069f-a165-70867728950e/source`,
    ],
    [
      "a UUID with a bad variant nibble",
      `uploads/${OWNER_SUB}/0f8fad5b-d9cb-469f-1165-70867728950e/source`,
    ],
    ["a wrong final segment", `uploads/${OWNER_SUB}/${VIDEO_ID}/original`],
    ["a trailing slash", `uploads/${OWNER_SUB}/${VIDEO_ID}/source/`],
  ])("rejects %s", (_label, key) => {
    expect(() => parseUploadKey(key)).toThrow(InvalidUploadKeyError);
  });

  it("exposes the offending key and a machine-readable code", () => {
    let caught: unknown;
    try {
      parseUploadKey("nope");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidUploadKeyError);
    const typed = caught as InvalidUploadKeyError;
    expect(typed.code).toBe("INVALID_UPLOAD_KEY");
    expect(typed.key).toBe("nope");
    expect(typed.message).toContain("nope");
  });
});

describe("isUuid", () => {
  it("accepts RFC-4122 UUIDs of any version, not just v4", () => {
    expect(isUuid("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true); // v4
    expect(isUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true); // v1
    expect(isUuid("6fa459ea-ee8a-3ca4-894e-db77e160355e")).toBe(true); // v3
    expect(isUuid("018f2b5a-7c3d-7e8f-9a0b-1c2d3e4f5a6b")).toBe(true); // v7
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true); // nil
  });

  it("rejects non-UUID strings", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("0f8fad5b-d9cb-469f-a165-70867728950")).toBe(false);
    expect(isUuid("0f8fad5b-d9cb-469f-a165-70867728950g")).toBe(false);
    expect(isUuid("0f8fad5bd9cb469fa16570867728950e")).toBe(false);
  });
});

describe("output key helpers", () => {
  it("builds the HLS output prefix", () => {
    expect(outputHlsPrefix(VIDEO_ID)).toBe(`outputs/${VIDEO_ID}/hls/`);
  });

  it("builds the thumbnail output key", () => {
    expect(outputThumbnailKey(VIDEO_ID)).toBe(`outputs/${VIDEO_ID}/thumb.jpg`);
  });
});
