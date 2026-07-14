# Fluid LGPD and Privacy Audit

Audit date: 2026-07-14  
This is a practical engineering review, not legal advice. It covers the backend repository and the single included account-settings page. The full Fluid frontend, Privacy Policy, Terms, and consent/notice surfaces were not present and therefore could not be verified.

## Executive privacy conclusion

Fluid processes account identifiers, authentication/session data, payment identifiers, user prompts, source code, generated apps, uploaded images, connector credentials, and data entered by end users into generated apps. Prompts, code, images, and runtime collections may contain sensitive or third-party personal data even when Fluid does not ask for it explicitly.

The patch materially improves deletion, storage retention, preview confidentiality, log minimization, and deleted-account blocking. Remaining LGPD priorities are transparency at collection time, a usable access/export workflow, documented retention/legal bases, processor/international-transfer disclosures, build/sandbox isolation, and operational proof that backups/logs/provider copies follow deletion schedules.

## Personal-data map

| Data | Source and storage | Purpose/flow | Current retention/deletion | Risk and action |
|---|---|---|---|---|
| Name, email, verified flag, avatar, profile, username, company/location, preferences | `models/User.js:5-191`; browser settings cache at `public/settings/account/index.html:600-645` | Account, profile, personalization | User tombstone retained; raw fields cleared on delete | Define legal basis and retention. Stop caching email/profile longer than needed; clear cache on logout/delete. |
| Password hash | `models/User.js:19-24`; bcrypt in `routes/authRoutes.js:1898-1905` | Local authentication | Cleared on account deletion | Good hashing. Enforce password policy without collecting password telemetry. Never log it. |
| Google/GitHub IDs and verified provider email | `models/User.js:26-38`; OAuth callbacks `routes/authRoutes.js:1680-1856` | Federated login/linking | Raw IDs cleared; keyed tombstone hashes retained | Disclose providers and international transfer. Document security/anti-abuse purpose and retention for hashes. |
| 2FA encrypted TOTP secret, hashed recovery codes, verification times | `models/User.js:193-226`; `utils/twoFactor.js:12-116` | Account security | Cleared on account deletion | Use a dedicated encryption key and rotation plan. Treat recovery output as highly sensitive. |
| JWT session ID, user agent, HMAC IP hash, timestamps/revocation reason | `models/Session.js:3-48`; `utils/auth.js:48-79` | Session security and device management | Seven-day expiry; patched TTL index | Disclose security metadata and retention. Migrate the production TTL index and periodically purge revoked sessions if their expiry is extended. |
| Stripe customer/subscription IDs, status, period end | `models/User.js:115-138`; `routes/billingRoutes.js:277-434` | Billing entitlement and portal | Cleared on Fluid account delete; Stripe keeps its own legally required records | Treat IDs as personal data. Disclose Stripe and its independent retention. Do not expose IDs to the frontend. No card/CVV collection was found. |
| Project names, descriptions, prompts, settings, source/generated code, SEO, publication URLs | `models/Project.js:7-329`; `models/ProjectBuild.js:6-217` | AI building, preview, publish | Patched cascade on project/account delete; old orphan data requires reconciliation | Set active/archive retention. Warn that project/code may contain personal data or secrets. Isolate generated content. |
| Chat prompts and AI replies | `models/ProjectMessage.js:5-37`; create at `routes/chatRoutes.js:1533-1589` | AI decision/support and project change history | Patched cascade on delete; otherwise indefinite | Add retention controls and per-project conversation deletion. Do not log content. Include in export. |
| Change requests and connector labels | `models/ProjectChangeRequest.js:5-74` | Build workflow/admin processing | Patched cascade | Same retention as project; include in export. |
| Uploaded image bytes | memory upload and provider request at `routes/chatRoutes.js:43-58,216-263,1197-1230` | Visual AI context | Backend does not persist bytes; provider retention is external | High transparency need. Tell users before upload which provider receives it, purpose, retention/control, and that sensitive/third-party images should not be uploaded without authority. |
| Image filename, MIME, size, attachment flag | message/change-request metadata at `routes/chatRoutes.js:261-274,1533-1590` | UI/history/context marker | Same as chat/project | Filenames can contain personal data; minimize further by storing a generated display label instead of original name if UI does not need it. |
| Connector credentials (Stripe/OpenAI/Resend/etc.) | encrypted `models/ConnectorSecret.js:26-90` | Build/runtime integrations | Patched cascade on project/account delete | These are secrets and sometimes personal/business data. Dedicated key, rotation/versioning, access audit, and least-privilege scopes are required. Never include raw values in export/logs/build frontend. |
| Generated-app runtime users and records | `models/RuntimeDocument.js:3-39`; runtime routes | Data layer for apps made by Fluid customers | Patched project/account cascade; otherwise project-controlled and indefinite | Fluid may be processor/operator for customer end-user data. Provide customer deletion/export APIs, policy configuration, tenant isolation, and DPA terms. Default access is now owner-scoped. |
| Admin/build metadata, source ZIP, build logs | `models/BuildJob.js`, GridFS, controlled disk dirs | Compile and troubleshoot projects | Source ZIP normally deleted by worker; cascade patched | Define failed-job cleanup and log retention. Sandbox builds and prove cleanup after crashes. |
| IP/network and application logs | infrastructure plus safe metadata logs | Security/operations | Not defined in repo | Set a short documented retention, access control, regional transfer terms, and redaction tests. |

## LGPD findings and fixes

### P-01 — Collection-time AI/image transparency is missing — high, open

No notice was found in the available UI explaining that prompts, selected project context/code, conversation history, and image bytes go to AI providers. Backend flows are at `routes/chatRoutes.js:1140-1230,1265-1360`.

Minimal UI wording:

> Fluid sends your prompt and the project context needed to answer it to our AI providers. If you attach an image, its contents are also sent for visual analysis. Do not submit passwords, API keys, tokens, private keys, highly sensitive personal data, or third-party private data unless you are authorized to do so. See our Privacy Notice for providers, purposes, retention, and your rights.

Place this near the chat input and image picker, not only in the policy. Add a short first-upload confirmation if images are uncommon or particularly sensitive.

Verification: the notice is visible before sending; localized versions retain the same meaning; analytics do not capture prompt/image content; accessibility tests can reach the notice.

### P-02 — Privacy Notice and Terms were not present — high, open

The policy should clearly cover:

- controller contact and privacy channel;
- categories/purposes/legal bases for account, security, AI, billing, and generated-app data;
- Anthropic/OpenAI (as actually configured), Stripe, Google, GitHub, hosting/database/log vendors, and international transfers/safeguards;
- prompt/image/code processing and whether provider training is enabled or disabled under the commercial terms;
- retention by category, backups, logs, failed builds, and deletion timing;
- account/project deletion, identity tombstone, access/correction/portability/opposition/review rights, and ANPD complaint right;
- user responsibility and authority for third-party personal data, copyrighted material, and secrets;
- separate roles for Fluid customer data versus end-user runtime data, including a DPA/operator path.

Suggested concise clause:

> AI processing. To provide Fluid's builder, we send the prompt and only the project context needed for the requested operation to contracted AI providers. When you attach an image, the image is sent for visual analysis. Do not upload secrets or personal data you are not authorized to process. Provider, location, retention, and deletion details are listed in our subprocessors and retention sections.

Suggested billing clause:

> Payments. Checkout and billing management are provided by Stripe. Fluid receives billing identifiers and subscription status but does not collect or store full card numbers or CVV.

Suggested deletion clause:

> Deletion. Deleting a project removes its prompts, messages, connector credentials, runtime records, source snapshots, and builds from active systems. Deleting an account also revokes sessions and removes all projects. Limited security, fraud-prevention, legal, and backup records may remain for stated periods before secure deletion.

Verification: link policy/terms at registration, OAuth entry, image upload, checkout, and settings deletion; record policy version/time where required; test every language.

### P-03 — Data access/export is absent — high, open

No authenticated export route or documented manual workflow was found.

Minimal safe implementation:

1. Require a fresh session and password/2FA re-authentication.
2. Queue an export job; do not build large archives in the API request.
3. Include account/profile/preferences, session metadata, billing status without raw Stripe IDs unless necessary, projects, prompts/messages/change requests, publication metadata, and runtime records.
4. Exclude password hashes, TOTP secrets, recovery hashes, JWTs, admin data, internal model prompts, raw connector credentials, and provider secrets. List connector provider/name/status instead.
5. Encrypt the archive, provide a single-use short-lived download, audit access, and delete the archive quickly.

Verification: two-user IDOR test, re-auth expiry, field allowlist review, archive expiry, deletion after download, and a sample subject-access reconciliation against database records.

### P-04 — Deletion was incomplete — high, patched with operational follow-up

References: `routes/authRoutes.js:1320-1428`, `routes/projectRoutes.js:1621-1632`, `utils/projectDeletion.js:1-51`.

Future deletes now cascade active storage and revoke sessions. Required follow-up:

- reconcile historical orphan records/files created before this patch;
- define backup deletion/expiry and provider deletion behavior;
- add retry/reconciliation for partial filesystem/GridFS/database failures;
- decide and document the retention period/legal basis for the keyed deleted-identity tombstone;
- test cancellation/billing legal retention separately at Stripe.

### P-05 — Retention schedule is mostly undefined — medium, open

Only auth token lifetime and the patched session TTL are concrete. Prompts, messages, projects, runtime data, build logs, and operational logs otherwise persist until explicit deletion.

Suggested engineering schedule to validate with counsel/business needs:

| Category | Suggested default |
|---|---|
| Active account/project content | While active; user-controlled project deletion |
| Archived projects | 30-90 days, then delete or require explicit keep |
| Expired/revoked sessions | Automatic at seven days via TTL |
| OAuth state/preview capabilities | 10/15 minutes respectively |
| Failed build workspace/source ZIP | Immediate cleanup; reconciliation within 24 hours |
| Build logs | 30 days, redacted |
| Security/application logs | 30-90 days based on incident need |
| Export archives | 24-72 hours |
| Backups | Fixed rolling window, for example 30 days, with deletion propagation on expiry |
| Deleted-identity keyed hashes | Defined anti-abuse period; reassess indefinite retention |

Verification: automated expiry tests, storage inventory before/after, backup restore procedure that reapplies deletion tombstones, and quarterly retention reports.

### P-06 — Browser cache stores personal settings — medium, open

References: `public/settings/account/index.html:600-645`. Account settings including email/profile are cached in local storage with no expiry or logout/delete clearing shown in this repo.

Fix: cache only non-sensitive display preferences, add version/expiry, clear all Fluid cache keys on logout/account delete, and avoid generic `user`/`token` keys. Prefer server fetch for email/profile.

Verification: logout/delete then inspect storage; no email/profile/token remains. Shared-browser test must not show the prior user's data offline.

### P-07 — Processor/subprocessor and generated-app roles need definition — medium, open

Runtime collections may contain Fluid customers' end-user emails, orders, addresses, and free-form records. Define when Fluid acts as controller versus operator/processor, provide a DPA, subprocessor list, tenant deletion/export tools, incident notification process, and configurable customer privacy notices.

Verification: map a generated commerce app end-to-end; identify controller, legal basis, data-subject channel, retention, and every transfer for each field.

### P-08 — Data minimization and provider scoping are partially good but need enforceable limits — medium

Positive: chat uses recent history and bounded selected code context rather than every source file (`routes/chatRoutes.js:1265-1360`); image bytes are not persisted; full chat payload logging was removed.

Remaining fix: cap history count/total characters, document which context fields are sent, avoid sending saved prompt when irrelevant, prevent duplicate image provider calls, and add provider-side no-training/retention configuration where contractually available.

Verification: instrument staging with content-free metadata (field counts/bytes only) and confirm each task sends only necessary context.

## Rights workflow checklist

- Access/export: implement P-03 with identity verification and response SLA tracking.
- Correction: profile/preferences endpoints exist and validate fields (`routes/authRoutes.js:1441-1639`). Add correction for OAuth-derived name/avatar where appropriate.
- Deletion: patched; add reconciliation, backup expiry, and provider handling.
- Portability: use structured JSON plus optional source archive; document machine-readable format.
- Consent withdrawal/objection: identify processing based on consent/legitimate interest and provide controls where applicable; core contract processing can be explained separately.
- Automated processing: explain AI assistance and any material decisions. Provide human review/contact for contested outcomes; Fluid should not claim generated output is automatically correct.
- Authentication: require re-auth for exports/deletion and never ask users to email passwords, tokens, or identity documents without a secure process.

## Security measures relevant to LGPD

Implemented/verified:

- tenant ownership checks for Fluid projects and patched runtime data;
- encrypted connector/TOTP secrets;
- signed/revocable sessions and private preview capabilities;
- raw card data handled by Stripe-hosted pages, not Fluid;
- image size/type/signature controls and no image logging;
- cascading active-data deletion and TTL sessions;
- generic client errors and reduced provider/prompt logging;
- `.env` ignored and no tracked hardcoded secret found.

Still required:

- isolated generated-content origin and build sandbox;
- HttpOnly session design/strong CSP for the complete frontend;
- centralized access/audit logs with privacy-preserving retention;
- secret rotation and key versioning procedures;
- backup, restore, deletion-replay, incident response, and breach-notification runbooks;
- production data inventory and vendor contract verification.

## Post-fix privacy verification

1. Create a staging user with one of every data type, including image metadata, connector secret, runtime record, build/GridFS artifact, and published page.
2. Export the storage inventory without values; delete the project; verify every active record/path is absent and published URL returns 404.
3. Repeat with account deletion; verify session revocation, browser storage clearing, tombstone behavior, and no relinking.
4. Confirm backup copies expire on schedule and a restored backup replays deletion markers before service.
5. Search logs using non-secret canaries for prompt, filename, email, Stripe ID, auth header, and image base64; none should appear beyond explicitly approved redacted audit metadata.
6. Review actual AI/Stripe/OAuth/hosting contracts and dashboard settings against the published notice; code alone cannot prove provider retention or training terms.
