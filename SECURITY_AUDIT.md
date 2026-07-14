# Fluid Defensive Security Audit

Audit date: 2026-07-14  
Scope reviewed: `/home/mikaelz/FLUIDBE` only  
Method: static code review, safe local syntax/unit assertions, dependency audit; no production probing, brute force, load testing, or secret disclosure.

## Executive summary

The backend had two critical authorization defects: generated-app users could self-register as a privileged seller and alter other users' records, and unpublished build artifacts were publicly retrievable. Both are patched. OAuth login CSRF, incomplete deletion of project data, unsafe logging of chat/provider objects, upload content validation, session retention, and several abuse controls were also patched.

The most important remaining risks require architecture or product decisions rather than a small safe patch:

1. Generated, user-controlled JavaScript is served from the backend origin (`apps.askfluid.now`). It should run on a dedicated cookieless sandbox origin.
2. React/Vite builds run dependency install and build scripts without a true OS/container sandbox. Environment filtering does not contain filesystem, process, or network access.
3. Browser bearer tokens are discoverable in `localStorage`/`sessionStorage`, while the available account page has inline script and no effective CSP. An XSS in the full frontend could steal a seven-day token.
4. The complete frontend named in the audit request was not present in this repository. Only `public/settings/account/index.html` was available; `public/shell.js`, `public/shell.css`, builder pages, preview iframe code, Privacy Policy, and Terms were absent. Their API calls and DOM sinks remain unverified.

Current risk after the included patches: **high**, driven by generated-code/build isolation and frontend token exposure. Before the patches, risk was **critical**.

## Endpoint and frontend-call map

Mount order matters: Stripe billing is mounted before the general JSON parser so `/api/billing/webhook` receives raw bytes; see `server.js:636-638`.

| Base | Endpoints | Protection |
|---|---|---|
| `/api/auth` | Google/GitHub start + callback; register; login; 2FA login; logout; `/me`; settings; 2FA setup/enable/disable/recovery regeneration; password; sessions; account delete; profile; preferences; onboarding | Public entry points are rate-limited globally; login and 2FA have dedicated limits. Private routes use JWT + `jti` session validation (`middleware/authMiddleware.js:11-87`). OAuth state is browser-bound after patch. |
| `/api/projects` | list/create; project CRUD; connector list/save/delete; latest build; build status/security scan/publish; messages; file tree/content | Every private endpoint uses `authMiddleware`; project and build lookups pair IDs with `userId`/`projectId` (`routes/projectRoutes.js:790-1632`). |
| `/api/chat` | `POST /clarify`, `POST /` with optional image | JWT, IP and user limits, project ownership (`routes/chatRoutes.js:1449-1626`). |
| `/api/billing` | webhook; `/me`; checkout; portal | Webhook signature; other routes JWT (`routes/billingRoutes.js:445-623`). |
| `/api/connectors` | registry and provider definition | JWT (`routes/connectorRegistryRoutes.js:203-215`). |
| `/api/admin` | change requests; all-project/file/message/connector/build operations; React/Vite upload/build/publish/status/security scan | Every declared route includes `requireAdmin`; representative gate at `routes/adminRoutes.js:343-351`, declarations at `routes/adminRoutes.js:2287-3263`. |
| `/api/runtime/:projectId` | generated-app register/login/me and collection list/get/create/update/delete | Runtime-project validation, runtime token, policy, ownership, and patched auth rate limit (`routes/runtimeRoutes.js:121-378`). |
| non-API | `/builds/...`, `/p/:slug`, settings account page, debug build marker | Published slug is public. Private builds now require signed short-lived capability, active owner session, or admin token (`server.js:455-512`). |

Frontend API calls present in this repo are limited to `GET /api/auth/me/settings`, `PATCH /api/auth/me/profile`, and `PATCH /api/auth/me/preferences` (`public/settings/account/index.html:541-569,744-828`). The rest of the requested frontend inventory could not be produced because those files are absent.

## Critical findings

### C-01 — Runtime role escalation and cross-user record modification — patched

References: `routes/runtimeRoutes.js:124-169`; `utils/runtimePolicies.js:1-40`; authorization decisions at `utils/runtimePolicies.js:70-107`.

Plain-language scenario: anyone could register in a generated app while choosing `seller`. That role was allowed to update or delete every product, regardless of owner. The `tasks` collection also allowed anyone, even without a token, to modify records, and unknown collections were publicly readable.

Minimal fix applied:

- reject self-assignment of `seller`;
- let only an internally provisioned `admin` bypass ownership for products;
- require authentication and ownership for tasks;
- make unknown collections private and owner-scoped by default;
- limit runtime register/login to 10 attempts per project/IP per 15 minutes.

Verification:

1. Register with role `seller`; expect 403 `RUNTIME_AUTH_ROLE_FORBIDDEN`.
2. Create product A as user A and try to patch/delete it as user B; expect 403.
3. Read a non-public collection as anonymous; expect 401.
4. Read another user's record in a default collection; expect 404.
5. Confirm public product reads still work.

### C-02 — Unpublished builds were public — patched

References: authorization now at `server.js:455-512`; signer at `utils/buildPreviewAccess.js:1-61`; URL application at `routes/projectRoutes.js:635-643`, `routes/adminRoutes.js:183-191`, and `utils/projectPublication.js:43-51`.

Plain-language scenario: a person who learned or guessed a project ID and timestamp-like build key could download a private draft's HTML, JavaScript, assets, or source-derived content without logging in.

Minimal fix applied: unpublished preview URLs now carry a 15-minute HMAC capability. The initial iframe request receives an HttpOnly cookie scoped to that exact build path so relative assets continue working. Published projects stay public. Direct bearer fallback now checks the session database, so logout/revocation is honored.

Verification:

1. Request a draft `/builds/...` URL without token/cookie/auth; expect 404.
2. Obtain build status as its owner; open returned signed preview; expect the page and relative assets to load.
3. Change the build key or signature; expect 404.
4. Revoke the owner session and try an unsigned build request with the old JWT; expect 404.
5. Open a published project and its assets; expect normal public access.

## High findings

### H-01 — OAuth `state` was absent for Google and not browser-bound for GitHub — patched

References: cookie binding helpers `routes/authRoutes.js:126-187`; OAuth starts `routes/authRoutes.js:898-938`; callback checks `routes/authRoutes.js:1680-1689,1756-1773`.

Plain-language scenario: an attacker could begin OAuth for the attacker's provider account and cause a victim's browser to finish that flow, leaving the victim signed into the wrong Fluid account. A signed state token alone did not prove that the same browser started the flow.

Minimal fix applied: both providers now use signed, expiring state plus a matching HttpOnly, `SameSite=Lax`, callback-path cookie and timing-safe comparison. Redirect paths remain same-origin normalized.

Verification:

1. Start each OAuth flow and confirm a Secure/HttpOnly callback-scoped cookie in production.
2. Complete normally; expect success and cookie removal.
3. Remove the cookie, alter state, or reuse a completed callback; expect an OAuth error.
4. Confirm an external or `//host` redirect is normalized to `/projects.html`.

### H-02 — Account/project deletion retained sensitive data and published content — patched

References: account flow `routes/authRoutes.js:1320-1428`; project flow `routes/projectRoutes.js:1621-1632`; cascade `utils/projectDeletion.js:1-51`; deleted-identity tombstone `models/User.js:228-249` and `routes/authRoutes.js:688-707,1368-1372`.

Plain-language scenario: after receiving “account deleted” or “project deleted,” prompts, messages, connector credentials, runtime data, builds, and published artifacts remained in storage. Published apps could remain reachable. The cleared OAuth IDs/email also allowed the same identity to be treated as a new account.

Minimal fix applied: deletion cascades across project, build, job, message, change-request, connector-secret, runtime, GridFS, and controlled build directories. Account sessions are revoked. A keyed, pseudonymous identity tombstone prevents re-registration/re-linking without retaining the raw email/provider ID.

Verification:

1. Delete a test project containing each data type; query every related collection and controlled path; expect no records/files.
2. Delete a test account; expect all sessions revoked and all projects inaccessible/unpublished.
3. Attempt password registration and both OAuth providers using the deleted identity; expect rejection.
4. Test a simulated GridFS/filesystem failure: the endpoint should fail generically and operations staff should reconcile residual data. Add a deletion reconciliation job before production scale.

### H-03 — Generated code shares the backend origin — open

References: generated artifacts and published HTML are served by `server.js:639-648,676-696`; no restrictive CSP is applied to build routes by design at `server.js:175-203`.

Plain-language scenario: generated or intentionally malicious JavaScript runs under `apps.askfluid.now`, the same origin as sensitive backend-hosted pages and APIs. Any browser credential or future cookie scoped to that origin can become reachable to generated code; origin-level controls cannot distinguish Fluid code from a generated app.

Minimal safe fix: serve all generated preview and published content from a dedicated, cookieless origin such as `*.sandbox.askfluid.now` or a separate registrable domain. Never set Fluid auth/admin cookies there. Keep runtime APIs on the backend with narrow CORS. Add `Content-Security-Policy: sandbox ...` only after testing runtime features. This requires DNS/deploy/frontend coordination and was not patched automatically.

Verification:

1. Confirm generated pages have a different origin from auth/admin/API pages.
2. Confirm the sandbox origin has no Fluid cookies/local storage.
3. From a generated page, verify same-origin reads of Fluid settings/admin pages fail.
4. Re-test preview, publish, assets, runtime API, downloads, popups, and forms.

### H-04 — Build pipeline executes untrusted dependency scripts without containment — open

References: install/build calls `workers/reactViteBuildWorker.js:134,163-171`; legacy path `routes/adminRoutes.js:1651-1719,1830-1836`; environment filtering `routes/adminRoutes.js:110-112,1699-1706`.

Plain-language scenario: a malicious dependency or package lifecycle script in an uploaded/generated project can execute commands as the build worker, access its filesystem, and use its network. Removing secret environment variables reduces exposure but is not a sandbox.

Minimal safe fix: run each build in an ephemeral container/VM with a read-only base, disposable writable workspace, non-root user, CPU/memory/time/pid limits, no host mounts, no cloud metadata, and outbound network allowlisting. Use `npm ci --ignore-scripts` where compatible, then explicitly allow only the required build command. Pin lockfiles and scan dependencies.

Verification:

1. In staging, build a harmless fixture whose lifecycle script attempts to write outside the workspace and contact a blocked test host; both must fail.
2. Confirm the worker cannot read service `.env`, Mongo credentials, connector keys, or host paths.
3. Confirm timeout and resource limits terminate runaway builds without affecting the API.

### H-05 — Browser tokens are script-readable and frontend coverage is incomplete — open

References: broad token discovery in `public/settings/account/index.html:324-469`; Authorization use at `public/settings/account/index.html:541-553`; seven-day JWT at `utils/auth.js:5-6,40-45`; CSP omission at `server.js:183-195`.

Plain-language scenario: one XSS anywhere on a frontend origin that stores these tokens can read a seven-day bearer token and use the victim's account until logout/revocation. The available page searches many generic storage keys, increasing accidental token pickup.

Minimal safe fix: move the main session to a Secure, HttpOnly, `SameSite=Lax/Strict` cookie with CSRF protection, or use an in-memory short-lived access token plus HttpOnly refresh rotation. Remove generic key scanning. Move inline JS/CSS to static files and deploy a nonce/hash CSP. This needs the missing frontend and coordinated auth changes, so it was not patched here.

Verification:

1. Confirm `document.cookie`, local storage, and session storage contain no reusable Fluid session secret.
2. Confirm state-changing requests reject missing/invalid CSRF tokens if cookie auth is adopted.
3. Run CSP in report-only, then enforcement, and exercise login/settings/builder/billing.

### H-06 — Sensitive response/provider objects could be logged — patched

References: chat now logs only mode/status at `routes/chatRoutes.js:1620-1624`; safe error metadata at `server.js:705-713`, `routes/billingRoutes.js:52-58`, `routes/runtimeRoutes.js:51-57`; worker sanitization at `workers/reactViteBuildWorker.js:301-335`.

Plain-language scenario: full chat replies/change requests and provider error objects could place prompts, generated content, customer IDs, request details, or sensitive nested fields into centralized production logs.

Minimal fix applied: removed the full chat payload log and reduced error logging to name/code/status. Existing build-log secret redaction remains in place.

Verification:

1. Send a canary string in a prompt/image filename and induce safe provider failures in staging.
2. Search application/worker logs for the canary, bearer patterns, image base64, Stripe IDs, and connector values; expect none.
3. Confirm operational error name/code/status remains sufficient for alerting.

## Medium findings

### M-01 — Rate limiter is process-local and several costly routes rely only on broad limits

References: in-memory `Map` at `middleware/rateLimit.js:19-55`; global and route limits `server.js:65-84,636,698-702`; auth-specific limits `routes/authRoutes.js:43-57`; checkout route `routes/billingRoutes.js:511-589`.

Scenario: limits reset on restart and are independent per instance. Distributed attempts can target OAuth callbacks, 2FA setup/recovery regeneration, checkout/portal, and admin endpoints beyond the intended effective limit.

Fix: use a Redis-backed limiter; key login/2FA by IP plus normalized account hash; add conservative per-user billing, OAuth, recovery, and upload limits. Do not reveal account existence.

Verify: exercise limits across two staging instances and after restart; confirm shared counters and `Retry-After` without blocking normal parallel asset/API use.

### M-02 — 2FA login challenges are replayable during their five-minute lifetime

References: challenge creation `routes/authRoutes.js:801-810`; verification `routes/authRoutes.js:1916-1968`; recovery-code mutation `routes/authRoutes.js:850-878`.

Scenario: a stolen challenge plus current TOTP can create more than one session. Concurrent recovery-code requests may both verify before one save marks the code used.

Fix: include a random challenge `jti`, store only its hash with expiry, and atomically consume it. Atomically claim recovery-code use (or serialize verification per user). Rate-limit recovery regeneration too.

Verify: submit the same successful challenge twice and concurrently submit one recovery code; exactly one request should succeed.

### M-03 — Project and history validation remains too permissive

References: project creation/update `routes/projectRoutes.js:805-869,1580-1618`; schema strings without maximums `models/Project.js:15-195`; history normalization `routes/chatRoutes.js:352-364`; 100 KB JSON cap `server.js:638`.

Scenario: an authenticated user can store very large names/descriptions/prompts or nested settings within the global body cap, causing oversized database/provider work and inconsistent rendering. Multipart history is field-capped but individual history items/count are not explicitly rejected.

Fix: define per-field limits and allowlists (for example name/title 120, description 2,000, prompt/message 20,000, history 20 items with 20,000 total characters); reject unknown keys and return 400/413.

Verify: boundary tests at limit, limit+1, arrays/objects instead of strings, control characters, and nested `$`/dot keys.

### M-04 — Image bytes are ephemeral but image-only requests still inject synthetic text

References: default prompts `routes/chatRoutes.js:40-44,199-202`; fallback text insertion `routes/chatRoutes.js:1200-1205`; upload controls `routes/chatRoutes.js:23-58,216-263`.

Scenario: an image-only message is persisted/sent with text the user did not type. This can misrepresent user intent and complicate access/export records.

Fix: represent message content as typed nullable text plus a separate attachment part; send image-only provider input without fabricated user prose where supported. If a provider requires text, label it as system-generated metadata and do not persist it as user-authored content.

Verify: send image-only; confirm stored/exported user text is empty and provider receives the image attachment exactly once. The patch already enforces PNG/JPEG/WebP size, field, filename, and signature checks at `routes/chatRoutes.js:23-58,216-263`.

### M-05 — Static admin token has no operator identity, rotation protocol, or network boundary

References: `routes/adminRoutes.js:343-351`; CORS permits the header at `server.js:58-64`; admin rate key at `server.js:80-84`.

Scenario: compromise of the single token gives broad read/write/build access and actions cannot be attributed to an operator.

Fix: place admin routes behind identity-aware access (SSO/MFA), role/scoped authorization, short-lived credentials, IP/VPN allowlist, audit events, and rotation. Retain the token only as a second factor during migration; compare it timing-safely.

Verify: normal JWT alone returns 401; expired/revoked admin identity fails; allowlist blocks outside staging IP; audit entry identifies operator/action/resource.

### M-06 — Stripe webhook user matching is permissive and billing abuse limits are broad

References: OR matching in `routes/billingRoutes.js:285-434`; signature validation `routes/billingRoutes.js:445-465`; allowlisted plan/price `routes/billingRoutes.js:511-566`.

Scenario: a trusted but inconsistent Stripe event containing conflicting customer/subscription/user metadata could update the first matching user rather than fail closed. Repeated checkout/portal requests rely on the global API limit.

Fix: require identifier consistency: retrieve the Stripe object, resolve one customer, find exactly one Fluid user, then require metadata `userId` (if present) to match. Add per-user billing limits and webhook event-id idempotency storage.

Verify: signed fixtures with conflicting IDs must be rejected/alerted; duplicate event IDs must be harmless; arbitrary client price IDs must remain ignored.

### M-07 — CSP and header coverage is partial

References: headers at `server.js:175-203`; account inline script/style `public/settings/account/index.html:7-202,316-838`.

Scenario: `X-Frame-Options`, nosniff, Referrer-Policy, Permissions-Policy, patched HSTS, and API no-store exist, but there is no effective CSP. Inline code prevents a strong `script-src` without refactoring.

Fix: move inline assets, use nonce/hash CSP, add `base-uri 'none'`, `object-src 'none'`, explicit `connect-src`, and `frame-ancestors`. Apply a separate tested policy to generated content/sandbox origin.

Verify: CSP report-only shows no required violations; then enforce and test settings, OAuth callback, billing redirects, preview/publish, images, and generated apps.

### M-08 — Data export/access workflow is absent

No export endpoint or admin workflow was found. See the privacy report for a minimal, authenticated, redacted export design and LGPD implications.

## Low findings

### L-01 — Public debug build endpoint

Reference: `server.js:662-674`.

It exposes build marker/file metadata without authentication. Remove in production or guard with admin access. Verify it returns 404 on production hosts.

### L-02 — Error/status and CORS hardening details

References: CORS list `server.js:49-64`; webhook signature error `routes/billingRoutes.js:453-465`; generic API error handler `server.js:705-717`.

The CORS list is explicit and good, but remove stale Render/local origins from production configuration rather than source. Return a fixed webhook signature error instead of provider text. Add `Vary: Origin` verification. Current client-facing 500s are generally generic.

### L-03 — Dependency drift, no known vulnerability

`npm audit` reported 0 vulnerabilities across 189 dependencies. `npm outdated` found newer releases for Anthropic SDK, adm-zip, mongoose, Stripe, and uuid; none is currently an audit finding. Update in small tested batches, especially ZIP and ODM libraries.

## Positive controls verified

- No tracked `.env`; `.gitignore` ignores `.env` and `node_modules`. The local env file was inspected by key name only and no value was printed.
- No hardcoded secret value was found in tracked source using key/prefix/private-key heuristics. Frontend-visible connector registry entries are labels/placeholders, not credentials.
- JWT auth checks signature/expiry, requires `jti`, validates active session, checks deleted account, and supports logout/session revocation (`middleware/authMiddleware.js:11-87`; `routes/authRoutes.js:2025-2061`).
- Passwords and recovery codes use bcrypt; TOTP secrets and connector credentials use AES-256-GCM (`utils/twoFactor.js:12-60`; `utils/connectorSecrets.js:43-84`). Password creation/change now rejects bcrypt's over-72-byte ambiguity.
- Project, build, connector, message, and file routes consistently bind resource IDs to authenticated ownership. No direct IDOR was found in those routes.
- All admin endpoints found require the admin token; a normal JWT is not accepted as admin.
- Stripe uses hosted Checkout/Portal, server-selected price IDs, and signed raw-body webhooks. No card number/CVV fields or persistence were found.
- Image bytes are memory-only, capped at 8 MB, restricted to PNG/JPEG/WebP, checked by file signature, and not logged. Only filename/type/size metadata is persisted.
- ZIP extraction blocks traversal/symlinks and caps archive size, entry count, expanded size, entry size, and compression ratio (`routes/adminRoutes.js:1046-1217`).
- Runtime query/body validation blocks Mongo operators, dotted keys, and project/owner overrides (`utils/runtimeValidation.js:29-133`).
- Available account DOM output uses `textContent`/form values rather than HTML insertion (`public/settings/account/index.html:472-479,641-710`).

## Validation performed

- JavaScript syntax check for every backend JS file: passed.
- Targeted assertions for signed preview tokens and runtime policies: passed.
- `npm audit --json`: passed, 0 known vulnerabilities.
- `npm outdated --json`: completed; drift listed above.
- `git diff --check`: passed before report creation and must be rerun at final handoff.
- `npm run build`: unavailable; no build script exists.
- `npm test`: script exists but is a placeholder that intentionally exits 1 (`package.json:8-11`).

## Deployment checklist for patches

1. Set distinct strong secrets: `JWT_SECRET`, `RUNTIME_JWT_SECRET`, `BUILD_PREVIEW_SECRET`, `TWO_FACTOR_SECRET_KEY`, `CONNECTOR_SECRET_KEY`, `SESSION_IP_HASH_SECRET`, and `DELETION_IDENTITY_SECRET`. Rotate carefully; changing deletion identity secret makes existing tombstones unmatchable.
2. Ensure production sets `NODE_ENV=production` so Secure cookies and HSTS are active.
3. Migrate the existing ordinary `sessions.expiresAt` index to the TTL index declared at `models/Session.js:47-48`; verify with `listIndexes()` before relying on automatic cleanup.
4. Backfill deleted-identity hashes for any pre-patch tombstones only if raw identities are lawfully available; otherwise document that older deletions cannot be blocked by the new hash.
5. Test preview signed URLs through the actual frontend and CDN. Do not cache private signed HTML or capability URLs.
6. Run deletion reconciliation against old orphaned projects/messages/builds/GridFS/files because the patch only affects future deletions.
7. Move generated content and build execution into isolated origins/workers before treating the system as low risk.
