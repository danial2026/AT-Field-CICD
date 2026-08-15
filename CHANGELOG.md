# Changelog

## [0.0.4] - 2026-08-15

### Dashboard UI
- The "By type / trigger" donut chart on the Dashboard now renders as a true
  circle (was stretched into an oval by the bar-chart `preserveAspectRatio`).
- Removed the divider line above the buttons in every form (`.form-actions`
  `border-top`) and the header divider line above the tab bar; header padding
  above the tabs tightened.
- Tab bar is now horizontally scrollable at any viewport width (hidden
  scrollbar), so the ten tabs never overflow the page on small screens.
- Phones and small screens get a dedicated layout: full-screen scrollable
  modals, stacked `.copy-row` / `.template-input-row` rows, full-width form
  action buttons and wrapped item actions, two-column stats grid, and
  wrap-friendly `.item-details` (long JSON no longer overflows).
- New **About** card on the Profile tab: app version plus Source Code
  (GitHub) and Developer Site links. The version is served from
  `package.json` via `/api/auth/me` and `/api/settings`, so it works for
  every role.

### Demo & Docs
- New `scripts/seed-demo.js`: wipes the DB and `logs/`, then seeds
  production-looking demo data — users (admin / sarah.ops / mike.dev,
  password `demo1234`), machines on `*.at-field-cicd.com`, repos, scripts,
  actions, notification targets, job runs with real log files, audit entries
  and settings (`app_url` = `https://at-field-cicd.com`).
- `scripts/screenshot-dashboard.py` now captures all ten tabs including
  **Machines** (login screenshot dropped); all `screenshots/` regenerated.
- Version bumped to `0.0.4` in `package.json` / `package-lock.json`;
  `README.md`, `SECURITY.md` and `docs/proxy-setup.md` references updated.

### Action-linked notifications
- An action may now select **which notification targets** should be informed
  when its job finishes, independent of the target's "notify on events"
  subscriptions: any *enabled* target picked on the action receives a
  completion notification (`event: action_notify`) even if the target has no
  matching event subscription.
- Per-action message template (`{{status}}`, `{{keyword}}`, `{{duration}}`,
  `{{repo}}`, `{{title}}` placeholders) rendered for the action-linked
  notification; empty/absent template falls back to the target's own template,
  then to the built-in default message.
- The action editor gained a **Notifications** section: checkbox list of the
  owner's notification targets, template textarea with a *Reset to default*
  button. The notifications modal has the same template reset button and now
  pre-fills the default template instead of an empty box.
- `repo_actions.user_id` records the action owner so action-linked
  notifications stay scoped to the owner's targets.
- Server enforces ownership on `PUT /api/repos/:id/actions/:keyword`:
  `notification_target_ids` must belong to the editing user (400 otherwise).

## [0.0.3] - 2026-08-15

### Deployment Machines (new deployment model)
- Actions are now **combined**: every action pairs a deploy step with a script
  (the old standalone `script`-only and `deploy`-only action types are gone).
- Deployment targets moved out of actions into a new **Machines** tab where
  `admin` / `devops` register SSH hosts (user, host, **port (default 22)**,
  optional key and ssh options). Every user may list machines to select them in actions.
- Each action targets **one or more machines** (multi-machine fan-out). The job
  connects to every machine in sequence: deploys via `rsync` or `ssh`, then
  streams and runs the action script **on the machine itself** (CI env vars
  exported, `cd /tmp`, `bash -s`).
- Machine deletion is blocked while any action still references the machine
  (409 with the referencing action count).
- Action editing (`PUT /api/repos/:id/actions/:keyword`) is now available to
  all authenticated users (was staff-only), matching the UI.
- The action editor in the dashboard gained a machine multi-select; machines
  are rendered on the Repositories tab from server data (legacy `script`-only
  actions still display as "runs on the CI host").
- `test-smoke.sh` rewritten around the new model: provisions a throwaway local
  `sshd` so combined deploy+script jobs run end-to-end in the smoke suite
  (falls back gracefully when `sshd` is unavailable), and now covers machine
  CRUD, RBAC on machines, and in-use deletion protection.

### SSH keys (encrypted at rest)
- New **SSH Keys** section in the Machines tab: upload a private key file
  (name + content, up to 16 KB), listed with a SHA-256 fingerprint.
- Keys are stored **AES-256-GCM encrypted** in the DB. Master key from
  `MASTER_KEY` env (64 hex chars) or auto-generated `data/master.key` (mode
  600) — back it up with the DB.
- Machines reference keys via a **dropdown** (replaces the raw SSH Key Path
  field); during a run the key is decrypted to a temporary `0600` file for that
  machine's deploy+script and deleted afterwards.
- Keys in use by a machine cannot be deleted (409 with the machine count).

### Docker
- `docker-compose.yml`: added `extra_hosts: host.docker.internal:host-gateway`
  so the container can reach services on the host (local sshd, capture servers,
  test targets).

### UI polish
- Strict black & white for native controls: `color-scheme: dark` on `:root`
  (select dropdown popups / option lists / file pickers now render dark) plus
  explicit `select option` colors and a themed `input[type="file"]` +
  `::file-selector-button` (black button, white text, `--white-10` border).
- Removed the divider line under every tab/section header (`.tab-header`
  `border-bottom`), keeping spacing with rebalanced padding. Keys section
  header now uses a proper `.tab-section-head` class instead of an inline style.

### Docs & Packaging
- Version bumped to `0.0.3` in `package.json` / `package-lock.json`.
- `README.md` version badge, `docs/proxy-setup.md` app-version reference, and
  `CHANGELOG.md` updated; `SECURITY.md` documents SSH-key encryption at rest,
  the master key, and machine ports.

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
