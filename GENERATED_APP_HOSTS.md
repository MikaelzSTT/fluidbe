# Generated application hostnames

## Configuration

Set the generated application base domain explicitly:

```dotenv
GENERATED_APP_DOMAIN=fluidapps.dev
```

There is intentionally no default. The configured value is trimmed and
lowercased, but it must otherwise already be a hostname: no protocol, path,
port, wildcard, or trailing dot. Missing or malformed configuration makes URL
builders throw and makes hostname parsing return no match. This prevents an
unconfigured process from classifying request hosts as generated applications.

This domain hosts generated, untrusted application code and is intentionally
separate from `askfluid.now`. The only canonical generated hostnames are:

- Preview: `pv-<publicHostKey>.fluidapps.dev`
- Published: `app-<publicHostKey>.fluidapps.dev`

Generated origins always use HTTPS. `publicHostKey` is public, immutable project
identity, not an authorization secret.

## Request boundary

`parseGeneratedAppHostname()` accepts only one canonical hostname string. It
does not accept a URL, port, comma-separated forwarding chain, trailing dot, or
uppercase/noncanonical key.

`resolveTrustedRequestHostname()` selects a request authority using Express's
configured `trust proxy fn`. It uses `X-Forwarded-Host` only when that function
trusts the immediate socket; otherwise it uses `Host`. It requires exactly one
selected authority, rejects forwarding chains and malformed values, safely
removes a valid port, and passes only the hostname token to the canonical
parser.

The application currently sets `trust proxy` to `1`. Express compiles that
numeric setting into a hop-count trust function, so the immediate socket
(`hopIndex === 0`) is trusted. Express's built-in `req.host` therefore accepts
`X-Forwarded-Host` from that socket and, by default, truncates comma-separated
values at the first comma. Generated-app resolution uses the same compiled
trust function but fails closed on commas or duplicate header values instead
of truncating them.

`resolveGeneratedAppRequest()` performs one exact `Project.publicHostKey` lookup
with a minimal projection and returns frozen identity context. Normal hosts and
missing/malformed generated-domain configuration produce no generated-host
context. Unknown keys return a uniform not-found result. Database failures use
a distinct internal error and map to the same non-disclosing public response as
unknown generated hosts.

## Private preview serving

Only canonical `pv-*` hosts are enabled. They accept `GET`, `HEAD`, and
`OPTIONS` for the existing `/builds/:projectId/:buildKey/*` path family. The
host-resolved project must equal the path project before build lookup or
artifact access. All other paths, unresolved hosts, and every `app-*` host
return the same 404 surface.

The preview host never treats publication or Fluid owner identity as preview
authorization. The existing signed `previewToken`, bound to the exact project,
build key, and expiry, is required even if the requested build is published.
After a valid query capability, `fluid_build_preview` is set as `HttpOnly`,
`Secure`, `SameSite=Lax`, without a `Domain` attribute, and with a path scoped
to that exact build. Existing `preview.askfluid.now` and normal `/builds`
authorization behavior remain unchanged.

## Cross-site iframe limitation

An iframe on `askfluid.now` loading `fluidapps.dev` is cross-site. Browsers do
not reliably store or send a `SameSite=Lax` preview cookie for iframe
subresources, and third-party-cookie blocking can prevent it independently of
SameSite. The current server does not apply the existing
`buildAssetCapabilities` rewriting helpers to served preview HTML, JavaScript,
or CSS, so Vite asset and chunk requests currently depend on the cookie unless
their URLs already carry `previewToken`.

Direct or top-level generated previews work with the host-only cookie. The
Builder iframe must not switch until a follow-up makes same-build asset
authorization independent of third-party cookies, preferably by narrowly
wiring the existing capability propagation helpers into generated-preview
HTML and textual code responses. Do not broaden the cookie to
`.fluidapps.dev` or treat owner sessions as a fallback.

## Security invariants

1. Host identity is not authorization.
2. Knowing `pv-<publicHostKey>.fluidapps.dev` does not grant preview access.
3. Preview capability checks remain required.
4. A published host must require both `Project.isPublished === true` and a valid
   `latestPublishedBuildId`.
5. Runtime access must still require `runtimeEnabled` and runtime-user
   authorization.
6. Generated hosts must never authenticate as Fluid owner sessions.

Existing `preview.askfluid.now/builds/*`, `preview.askfluid.now/p/:slug`, and
stored preview, build, deploy, and publication URLs remain unchanged. No
current API or frontend response emits a generated preview URL.
