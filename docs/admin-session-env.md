# Admin session configuration

These environment variables control the administrative session lifecycle:

- `ADMIN_ACCESS_TTL_MINUTES`: short-lived admin JWT/access window. Default: `20`.
- `ADMIN_IDLE_TIMEOUT_MINUTES`: idle timeout for a normal server-side admin session. Default: `120`.
- `ADMIN_ABSOLUTE_SESSION_HOURS`: absolute lifetime for a normal admin session. Default: `12`.
- `ADMIN_TRUSTED_DEVICE_DAYS`: trusted-device lifetime after a successful password + MFA login. Default: `7`.
- `ADMIN_MAX_SESSIONS_PER_ADMIN`: maximum active server-side admin sessions per admin. Default: `5`.
- `ADMIN_SESSION_COOKIE_NAME`: HttpOnly admin access cookie name. Default: `fluid_admin_session`.
- `ADMIN_TRUSTED_DEVICE_COOKIE_NAME`: HttpOnly trusted-device cookie name. Default: `fluid_admin_trusted`.
- `ADMIN_CSRF_COOKIE_NAME`: admin CSRF cookie name. Default: `fluid_admin_csrf`.
- `ADMIN_COOKIE_PATH`: admin cookie path. Default: `/api`.
- `ADMIN_COOKIE_SAMESITE`: admin cookie SameSite mode. Default: `lax`; use `strict` when the admin UI and API flow allow it.
- `ADMIN_COOKIE_SECURE`: force Secure cookies outside production. Production always uses Secure cookies.
- `ADMIN_CSRF_SECRET`: optional CSRF signing secret. Falls back to `ADMIN_JWT_SECRET`.
- `ADMIN_DEVICE_HASH_SECRET`: optional HMAC key for the non-invasive user-agent device hash.
- `ADMIN_DEVICE_TOKEN_SECRET`: optional HMAC key for trusted-device token hashes.

Do not configure `ADMIN_SESSION_TTL_MS` for production admin sessions. It is retained only as a legacy fallback for the access-token TTL.
