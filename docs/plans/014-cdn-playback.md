# 014 — CDN & playback

## Manual setup required BEFORE starting
1. **Generate the CloudFront signing key pair (you run, agent provides
   `scripts/generate-cf-keys.sh`):** RSA 2048 pair; the script uploads the
   **private** key to Secrets Manager (`clipper/cloudfront-signing-key`)
   and writes the **public** key to a temp file printed for you.
2. Public key handling: the agent wires the public key into CDK via a
   **context value / SSM parameter you create**
   (`aws ssm put-parameter --name /clipper/cf-public-key --type String
   --value fileb://...` — base64) so no private material ever enters the
   repo or CDK templates. Agent must never ask for the private key.

## Objective
Finished videos play in the browser via CloudFront signed cookies; the
output bucket stays completely private; the thumbnail becomes the poster
frame (and library card image — flip 013's feature constant).

## Context
ARCHITECTURE §2.5 + D2 (cookies not URLs). The player fetches dozens of
HLS files; one cookie set scoped to `/outputs/{videoId}/*` authorizes the
whole tree.

**The cross-domain constraint that shapes this design:** a server can only
set a cookie for its *own* response domain. Our API lives on the ALB
domain; HLS content lives on the CloudFront domain. The API therefore
cannot directly set cookies that CloudFront will honor. The standard
solution this plan implements:

1. The CloudFront distribution gets **two origins**: the output bucket
   (default behavior, OAC, signed) and the **ALB** (behavior
   `/api-auth/*`, caching disabled, cookies forwarded).
2. The playback page POSTs to `https://<cf-domain>/api-auth/playback/{id}`
   (cross-origin fetch with `credentials: 'include'`; CORS locked to
   `APP_ORIGIN`). Because the response comes from the CF domain, its
   `Set-Cookie` headers land on the CF domain.
3. hls.js then fetches `https://<cf-domain>/outputs/{id}/hls/master.m3u8`
   with `withCredentials: true` — cookies flow, CloudFront verifies them
   against the trusted key group.

For developer convenience the same handler is also mounted at
`/api/videos/:id/playback` on the ALB — useful for debugging the
authorization logic (it will set cookies on the wrong domain for actual
playback; that's expected and documented).

## Requirements
1. `CdnStack` (CDK):
   - CloudFront distribution: default behavior → output bucket via OAC
     (`/outputs/*`), `trustedKeyGroups` with the public key from SSM,
     caching tuned for HLS (playlists short TTL ~5s, segments long —
     two path behaviors: `*.m3u8` TTL 5s, default 24h).
   - Behavior `/api-auth/*` → ALB origin (HTTPS-allowed, forward cookies
     + the session cookie; cache disabled), so API responses can set
     cookies on the CF domain.
   - Bucket policy: OAC read only.
2. API: `POST /api-auth/playback/:id` (reach via CF domain) — also mount
   same handler at `/api/videos/:id/playback` for symmetry; auth:
   requireUser + owner + state READY; generate signed cookies
   (`@aws-sdk/cloudfront-signer` `getSignedCookies`) scoped
   `https://<cf-domain>/outputs/{id}/*`, TTL 4h; `Set-Cookie` ×3 with
   `Secure; HttpOnly; SameSite=None; Path=/outputs/{id}/`; respond with
   `{ masterUrl, thumbnailUrl }`; CORS: `Access-Control-Allow-Origin:
   {APP_ORIGIN}`, `Allow-Credentials: true` on this route only.
3. Player page `/videos/[id]/play`:
   - POST to the CF auth URL (cross-origin fetch, `credentials:
     'include'`), then hls.js on the returned master URL
     (`xhrSetup: { withCredentials: true }`); native HLS fallback
     (Safari); poster = thumbnailUrl; quality selector surfaced from
     hls.js levels.
   - 403 handling → "session expired, reload" affordance.
4. Flip 013's feature constant: library cards + detail poster now use
   `thumbnailUrl` via the same cookie (thumbnail is under
   `/outputs/{id}/` — covered by the same scoped cookies).
5. Middleware: `/api-auth/*` behaves as authenticated API (it's a
   distinct prefix — add to matcher, skip nothing).

## Files/components likely affected
- New: `infra/lib/cdn-stack.ts`, `infra/test/cdn-stack.test.ts`,
  `apps/web/app/api-auth/playback/[id]/route.ts` (+ alias route),
  `apps/web/app/videos/[id]/play/page.tsx`,
  `apps/web/components/Player.tsx`, `scripts/generate-cf-keys.sh`;
  edits: `infra/bin/infra.ts`, `infra/config.ts` (cf domain output
  feeding APP config — note deploy ordering: CdnStack needs ALB DNS
  (exists), app env needs CF domain → redeploy web after CdnStack,
  automate via pipeline ordering note), `packages/config`,
  013 components (poster/card images).

## API changes
- Adds `/api-auth/playback/:id` (POST) + `/api/videos/:id/playback`
  alias.

## Database changes
None.

## Dependencies
- 011 (thumbnail), 012 (HLS outputs), 013 (UI entry points).

## Edge cases
- Cookie TTL expiry mid-playback: hls.js keeps fetching → 403s → surface
  "re-auth" button re-POSTing for fresh cookies (4h makes this rare).
- Private/incognito third-party-cookie blocking: SameSite=None+Secure is
  required for cross-site fetch cookies; if the browser blocks them,
  playback fails — document known limitation; fallback idea (signed URLs
  via proxy) listed as Part B, not built.
- Video reprocessed (Part B) with same keys: short playlist TTL keeps
  staleness ≤5s.
- Owner revokes nothing in Part A — cookies expire naturally.
- Non-READY video → 409 from the endpoint; player shows state.

## Security considerations
- Private key lives only in Secrets Manager; CDK receives only the public
  key (SSM). Assert no private-key env var in any task definition beyond
  the web task's secret injection.
- Cookies scoped per-video path — one video's cookies grant nothing on
  another video.
- Bucket policy asserts OAC-only access (deny non-OAC principal).
- CORS on the auth route locked to `APP_ORIGIN` exactly, credentials
  true, no wildcards.

## Tests
- Unit: endpoint auth matrix (anon 401, foreign 404, not-ready 409,
  happy 200 + 3 cookies with correct Path/Domain/expiry).
- CDK assertions: OAC, trusted key group wired, `/api-auth/*` behavior
  no-cache + forwards cookies, playlist/segment TTL split.
- Manual matrix (documented): Chrome + hls.js playback with quality
  switching; Safari native; curl without cookies → 403; direct S3 URL →
  403; other user's video → 404.

## Acceptance criteria
1. Fresh browser profile: sign in, upload, wait READY, play — adaptive
   quality switching observed (hls.js level change / devtools).
2. All four denial checks in the manual matrix pass.
3. Thumbnail renders as poster and on library cards.
4. CloudFront cache hit ratio visibly > 0 on repeat segment fetches
   (CF metrics in console).

## Out of scope
- Custom domain + ACM cert (Part B — CF default domain fine for dev),
  signed URLs fallback, geo-restriction, WAF.
