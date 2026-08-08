# Changelog

## [0.0.1] - 2026-08-09

First release under the **AT Field CI** name (formerly `ci-webhook`).

### Renamed & Rebranded
- Project renamed `ci-webhook` to **AT Field CI** across package, server, dashboard,
  Docker, libs, and configs.
- Version reset to `0.0.1`.
- Default DB path changed to `data/at-field-ci.db` (old DB auto-discovered on boot).

### Security Hardening
- Added HTTP security headers on every response: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Disabled `X-Powered-By`.
- Restricted `git_token_hint` to staff viewers only (previously leaked last 4 chars
  of the token to any authenticated user).
- Rewrote `SECURITY.md` to match the DB-backed/session/RBAC architecture.

### Dashboard
- New branding: title, splash, login, and header updated to **AT Field CI**.
- Single icon source: `public/at-field-icon.svg` drives the favicon and all in-app
  icons (splash, login, logout, header). Change one file to rebrand everywhere.
- Show/hide password toggle on the login screen.
- Removed the profile button from the header (still reachable via the Profile tab).
- Captured fresh screenshots into `screenshots/`.

### Added
- `scripts/screenshot-dashboard.py` - dev utility to regenerate README screenshots.
- `LICENSE` (MIT).

### Known Limitations
- In-memory serial job queue (not persisted across restarts).
- Single Node.js process (no clustering).
- Up to 200 log files surfaced via the API (older files not auto-pruned).
