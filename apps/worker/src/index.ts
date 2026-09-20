import { JOB_KINDS } from "@clipper/shared";

/**
 * Placeholder worker entry point.
 *
 * The SQS long-poll loop, visibility heartbeat, S3 output writers, and
 * status callback client are implemented in feature 009
 * (`docs/plans/009-worker-base.md`). `@clipper/shared` and `@clipper/config`
 * are already wired as workspace dependencies for that work.
 */
function main(): void {
  const mode = process.env.WORKER_MODE ?? "(unset)";
  console.log(
    `[clipper-worker] placeholder — supported modes: ${JOB_KINDS.join(", ")}; WORKER_MODE=${mode}`,
  );
}

main();
