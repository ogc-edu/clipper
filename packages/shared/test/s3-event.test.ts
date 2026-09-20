import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  InvalidUploadKeyError,
  S3EventParseError,
  parseS3EventFromSqs,
} from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

const OWNER_SUB = "6f1c2f5e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
const VIDEO_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function objectCreatedBody(input: {
  key: string;
  eventName?: string;
  bucket?: string;
  requestId?: string;
  sequencer?: string;
}): string {
  return JSON.stringify({
    Records: [
      {
        eventVersion: "2.1",
        eventSource: "aws:s3",
        awsRegion: "us-east-1",
        eventTime: "2025-01-15T12:34:56.789Z",
        eventName: input.eventName ?? "ObjectCreated:Put",
        responseElements: {
          "x-amz-request-id": input.requestId ?? "REQ-1",
        },
        s3: {
          s3SchemaVersion: "1.0",
          configurationId: "clipper-uploads-object-created",
          bucket: { name: input.bucket ?? "clipper-uploads-dev" },
          object: {
            key: input.key,
            size: 1024,
            eTag: "d41d8cd98f00b204e9800998ecf8427e",
            sequencer: input.sequencer ?? "SEQ-1",
          },
        },
      },
    ],
  });
}

describe("parseS3EventFromSqs", () => {
  it("parses a captured ObjectCreated event with a URL-encoded key", () => {
    const event = parseS3EventFromSqs(fixture("s3-object-created.json"));

    expect(event).toEqual({
      videoId: VIDEO_ID,
      ownerSub: OWNER_SUB,
      uploadKey: `uploads/${OWNER_SUB}/${VIDEO_ID}/source`,
      bucket: "clipper-uploads-dev",
      eventId: "EXAMPLE123456789",
    });
  });

  it("decodes '+' as a literal space in URL-encoded keys", () => {
    const event = parseS3EventFromSqs(
      objectCreatedBody({
        key: `uploads%2Fteam+one%2F${VIDEO_ID}%2Fsource`,
      }),
    );

    expect(event.ownerSub).toBe("team one");
    expect(event.uploadKey).toBe(`uploads/team one/${VIDEO_ID}/source`);
  });

  it("accepts an unencoded key", () => {
    const event = parseS3EventFromSqs(
      objectCreatedBody({ key: `uploads/${OWNER_SUB}/${VIDEO_ID}/source` }),
    );

    expect(event.videoId).toBe(VIDEO_ID);
    expect(event.ownerSub).toBe(OWNER_SUB);
  });

  it("accepts other ObjectCreated variants (Post/Copy/CompleteMultipartUpload)", () => {
    const event = parseS3EventFromSqs(
      objectCreatedBody({
        key: `uploads/${OWNER_SUB}/${VIDEO_ID}/source`,
        eventName: "ObjectCreated:CompleteMultipartUpload",
      }),
    );
    expect(event.videoId).toBe(VIDEO_ID);
  });

  it("falls back to the object sequencer when the request id is absent", () => {
    const body = JSON.stringify({
      Records: [
        {
          eventName: "ObjectCreated:Put",
          s3: {
            bucket: { name: "clipper-uploads-dev" },
            object: {
              key: `uploads/${OWNER_SUB}/${VIDEO_ID}/source`,
              sequencer: "SEQUENCER-9",
            },
          },
        },
      ],
    });

    expect(parseS3EventFromSqs(body).eventId).toBe("SEQUENCER-9");
  });

  it("throws a typed error for an S3 test event", () => {
    expect(() => parseS3EventFromSqs(fixture("s3-test-event.json"))).toThrow(
      S3EventParseError,
    );
  });

  it("throws a typed error for malformed JSON", () => {
    expect(() => parseS3EventFromSqs("{not json")).toThrow(S3EventParseError);
  });

  it("throws a typed error for an event with no Records", () => {
    expect(() => parseS3EventFromSqs(JSON.stringify({}))).toThrow(
      S3EventParseError,
    );
  });

  it("throws a typed error for an unsupported event name", () => {
    expect(() =>
      parseS3EventFromSqs(
        objectCreatedBody({
          key: `uploads/${OWNER_SUB}/${VIDEO_ID}/source`,
          eventName: "ObjectRemoved:Delete",
        }),
      ),
    ).toThrow(S3EventParseError);
  });

  it("throws a typed error for a malformed percent-encoding", () => {
    expect(() =>
      parseS3EventFromSqs(objectCreatedBody({ key: "uploads%2Fbad%2F%ZZ" })),
    ).toThrow(S3EventParseError);
  });

  it("propagates InvalidUploadKeyError for an off-convention key", () => {
    expect(() =>
      parseS3EventFromSqs(objectCreatedBody({ key: "not/a/clipper/key" })),
    ).toThrow(InvalidUploadKeyError);
  });
});
