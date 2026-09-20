import { z } from "zod";

/** Anything shaped like `process.env`. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Renders every Zod issue in a stable, human-readable form. The output is
 * intentionally exhaustive: callers see *all* missing/invalid variables in
 * one pass instead of fixing them one at a time.
 */
export function formatEnvIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Validates `source` (defaults to `process.env`) against a Zod schema.
 *
 * @throws {Error} with a message listing every missing or invalid variable.
 */
export function loadEnv<T extends z.ZodType>(
  schema: T,
  source: EnvSource = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${formatEnvIssues(result.error)}`,
    );
  }
  return result.data as z.infer<T>;
}
