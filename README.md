# Clipper

Upload, transcode, and stream video. A user signs in, uploads a video
directly to object storage, watches background workers convert it into
adaptive HLS plus a thumbnail, then plays it back through a CDN.

This repository is a pnpm + TypeScript monorepo. Feature 001 contains the
workspace scaffold only — no AWS resources are created yet.

## Documentation

| Document                                                     | Description                         |
| ------------------------------------------------------------ | ----------------------------------- |
| [`docs/PRD.md`](docs/PRD.md)                                 | Product requirements                |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)               | System design and repo layout (§11) |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Feature-by-feature master plan      |
| [`docs/plans/`](docs/plans)                                  | Per-feature implementation plans    |

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`npm install -g pnpm`, or `corepack enable`)

## Setup

```bash
pnpm install
```

## Scripts

| Command             | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `pnpm build`        | Builds every workspace package (topological order)        |
| `pnpm dev`          | Starts the `apps/web` Next.js dev server                  |
| `pnpm lint`         | Runs ESLint (flat config) over the whole repo             |
| `pnpm format`       | Formats the repo with Prettier                            |
| `pnpm format:check` | Verifies formatting without writing                       |
| `pnpm test`         | Runs all Vitest unit tests                                |
| `pnpm typecheck`    | Type-checks every package (after building workspace deps) |

Run a script for a single workspace package with a filter:

```bash
pnpm --filter @clipper/shared test
pnpm --filter @clipper/web dev
```

## Layout

```
clipper/
├── apps/
│   ├── web/            # Next.js App Router (UI + API route handlers)
│   └── worker/         # Node worker(s); WORKER_MODE=transcode|thumbnail
├── packages/
│   ├── shared/         # Domain types + S3 key-convention + S3 event parser
│   └── config/         # zod-validated environment schemas
├── docs/               # PRD, architecture, implementation plans
├── infra/              # (feature 002+) AWS CDK stacks
├── eslint.config.mjs   # Root ESLint flat config
├── tsconfig.base.json  # Shared strict TypeScript options
└── pnpm-workspace.yaml # Workspace globs + dependency catalog
```

## The S3 key convention

Two object-key conventions are enforced by `@clipper/shared`:

- Uploads: `uploads/{ownerSub}/{videoId}/source`
- Outputs: `outputs/{videoId}/hls/…` and `outputs/{videoId}/thumb.jpg`

`parseUploadKey()` throws a typed `InvalidUploadKeyError` for any key that
does not match exactly. `parseS3EventFromSqs()` parses the raw S3
`ObjectCreated` event delivered through SNS → SQS (URL-encoded keys and
`+`-for-space included) and throws typed errors for S3 test events and
malformed payloads.

## Environment

`@clipper/config` defines zod schemas for the web and worker environments
and a `loadEnv()` helper that reports every missing or invalid variable at
once. It only validates — nothing reads real secrets in this feature.

Never commit `.env*` files. See `.gitignore`.
