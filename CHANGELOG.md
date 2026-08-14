# Changelog

## [0.0.2] - 2026-08-15

### Dashboard UI
- Reordered navigation tabs: Dashboard, Repositories, Scripts, Notifications, Logs,
  Audit, Settings, Users, Profile.
- Renamed the **Repos** tab to **Repositories**.
- The **Users** tab is now visible to `devops` and `admin` roles (was admin-only).
  Note: user-management API endpoints remain admin-only server-side.
- Removed the now-unused `isAdminUser` frontend state; tab gating is handled solely
  by the `isStaff` flag (admin + devops).
- Added a boot splash: a critical inline stylesheet paints a solid black screen
  from the first paint and masks the DOM until `app.js` is ready, preventing
  unstyled / half-broken HTML flashes during slow loads.

### Settings
- Settings cards now stack in a single column at full container width (was a
  narrow 820px column and, briefly, a 3-column grid).
- Number inputs constrained to 170px and their native spinners made visible in
  the dark theme (`color-scheme: dark`).
- "Save Settings" spans the full row, right-aligned.

### Checkboxes
- Restored to 16×16 black/white boxes (previously blown up by `appearance: none`).
- Checkmark drawn with an inline SVG background instead of a rotated `::after`
  border box, which rendered as an inverted "Λ" (the old check looked broken).
- Checkbox labels are optically centered on their text (2px glyph-center nudge).

### Misc UI
- All "Add / Create" header buttons (+ Add Repo, + Create Script, + Add Target,
  + Add User, + Action) are right-aligned.
- "Update Password" button is now full-width, matching the input fields above.

### Dev
- `scripts/screenshot-dashboard.py` now waits for the new landing tab
  (`#dashboard-tab.active`), captures all nine tabs plus the login page in
  navigation order, and defaults to a wider 1680×1050 @ 2× viewport
  (`VIEWPORT_W` / `VIEWPORT_H` / `SCALE_FACTOR` env overrides available).
- Refreshed all screenshots in `screenshots/` (login + 9 tabs).

### Docs & Packaging
- Version bumped to `0.0.2` in `package.json` / `package-lock.json`.
- `README.md`: screenshots moved above Quick Start in a 2-per-row table
  (login + 9 tabs in navigation order); removed the hero image and the
  role-visibility "Dashboard" section; added an "AI Assistance" section.
- `SECURITY.md`: documented that tab visibility (Audit / Settings / Users) is
  presentation-only and that every protected API remains server-enforced.
- `docs/proxy-setup.md`: app version reference updated to `0.0.2`.

## [0.0.1] - 2026-08-09

First release under the **AT FIELD CICD** name (formerly `ci-webhook`).

### Renamed & Rebranded
- Project renamed `ci-webhook` to **AT FIELD CICD** across package, server, dashboard,
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
- New branding: title, splash, login, and header updated to **AT FIELD CICD**.
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
