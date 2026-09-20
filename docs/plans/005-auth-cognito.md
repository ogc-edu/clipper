# 005 — Auth (Cognito + Next.js)

## Manual setup required BEFORE starting
- 002 deployed (CDK patterns exist). Decide the Cognito domain prefix in
  `infra/config.ts` (must be globally unique in the region, e.g.
  `clipper-<yourname>-dev`).

## Manual setup required AFTER deploy
- In the Cognito console: create your own user (email + password), confirm
  it, and add it to the `admin` group. Then verify sign-in end-to-end.

## Objective
Users authenticate via Cognito Hosted UI; the Next.js app holds an
HttpOnly session; every `/api/*` route (except auth + internal) requires a
verified JWT; admin routes require group membership.

## Context
ARCHITECTURE §2.6. The OAuth code flow runs server-side in route handlers;
the browser only ever sees an opaque session cookie. JWT verification is
local (JWKS from Cognito, cached) — no per-request AWS calls. Middleware
protects routes; `requireUser`/`requireAdmin` helpers are the per-handler
enforcement point (defense in depth — don't rely on middleware alone).

## Requirements
1. `AuthStack` (CDK):
   - User pool: email sign-in, self sign-up enabled, password policy
     default-strong; account recovery by email.
   - User pool domain (prefix from config).
   - App client: Authorization Code grant, callback URLs =
     `{appOrigin}/api/auth/callback` for app origins `http://localhost:3000`
     and the future ALB origin (config value, placeholder OK), logout URLs
     matching.
   - Group `admin`.
   - Outputs: user pool id, client id, domain, issuer URL.
2. `apps/web` auth module (`lib/auth/`):
   - `config.ts`: issuer, client id, JWKS URL, cookie name/opts — from env
     via `packages/config` (extend web env schema: `COGNITO_ISSUER`,
     `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`, `APP_ORIGIN`,
     `SESSION_SECRET` for cookie signing).
   - `session.ts`: sign/verify session cookie (signed, HttpOnly, Secure,
     SameSite=Lax, 8h) containing the ID token; verify ID token with
     `jose` against cached JWKS (issuer + audience + expiry enforced).
   - `requireUser(req)` → `{ sub, email, groups }` or 401 Response;
     `requireAdmin(req)` → 403 if `cognito:groups` lacks `admin`.
3. Route handlers:
   - `GET /api/auth/login` → 302 to Cognito `/oauth2/authorize`
     (response_type=code, scope `openid email`, state cookie).
   - `GET /api/auth/callback` → exchange code at `/oauth2/token`
     (server-side, client id only — no client secret needed for public
     client w/ PKCE: use PKCE), verify ID token, set session cookie,
     redirect to `/`.
   - `POST /api/auth/logout` → clear cookie → redirect to Cognito
     `/logout`.
   - `GET /api/auth/me` → current user JSON (handy for debugging/acceptance).
4. `middleware.ts`: matcher `/api/:path*`; skips `/api/auth/*` and
   `/api/internal/*`; rejects unauthenticated with 401 JSON (not redirect —
   these are API routes).
5. UI: placeholder home page shows signed-in email + logout button, or a
   "Sign in" link when anonymous. No design work.

## Files/components likely affected
- New: `infra/lib/auth-stack.ts`, `infra/test/auth-stack.test.ts`,
  `apps/web/lib/auth/*`, `apps/web/app/api/auth/*/route.ts`,
  `apps/web/middleware.ts`; edits: `infra/bin/infra.ts`,
  `packages/config` env schema, `apps/web/app/page.tsx`.

## API changes
- Adds `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`,
  `/api/auth/me`. All other `/api/*` now require auth (none exist yet).

## Database changes
None. (Cognito owns users; `videos.ownerSub` stores the `sub`.)

## Dependencies
- 001, 002. (004 not required — no DB use.)

## Edge cases
- Clock skew: allow 60s tolerance in JWT exp/iat checks.
- Missing/forged/tampered cookie → 401, never 500.
- State + PKCE verifier mismatch on callback → 400, clear cookies.
- Token refresh: out of scope (8h cookie); document that expiry forces
  re-login via Hosted UI.
- Logout must clear the cookie even if the Cognito redirect fails.

## Security considerations
- ID token never leaves the server except inside the signed HttpOnly
  cookie; never in localStorage, never to client components.
- Verify on every request: signature, issuer, audience (client id), expiry.
- `SESSION_SECRET`: env var now; migrate to Secrets Manager injection in
  006 (note in plan so it's not forgotten).
- PKCE used instead of a client secret (public client) — do not disable.

## Tests
- Unit: session sign/verify round-trip; tampered cookie rejected; expired
  token rejected; wrong-audience token rejected (mock JWKS with `jose`
  test keys).
- Unit: `requireAdmin` group-claim parsing (present/absent/malformed).
- CDK assertions: group exists, callback URLs match config, code grant +
  PKCE-friendly settings.

## Acceptance criteria
1. `cdk deploy` adds AuthStack cleanly.
2. Sign-in round trip via Hosted UI works on localhost; `/api/auth/me`
   returns your sub/email.
3. Unauthenticated call to a dummy protected route → 401 JSON.
4. Non-admin user → 403 on dummy admin route; after adding yourself to
   `admin` → 200.
5. Unit + assertion tests green.

## Out of scope
- Any video/upload functionality, admin UI, MFA, social identity
  providers, token refresh, user-management UI.
