# Security

AT FIELD CICD runs builds and deploys on your infrastructure. This document describes
the security controls in place and what you must do to deploy it safely.

## Authentication & Sessions

- **Session-based auth.** Login at `POST /api/auth/login` returns an HttpOnly cookie
  (`ci_session`). Passwords are hashed with **scrypt** (N=16384, r=8, p=1, 64-byte key)
  with a per-user random salt and verified with `crypto.timingSafeEqual`.
- **Cookies** are `HttpOnly`, `SameSite=Strict`, and `Max-Age` capped at the 7-day
  session TTL. Set `COOKIE_SECURE=1` when behind HTTPS so the `Secure` flag is added.
- **Rate limiting.** 5 failed logins per IP within 15 minutes triggers HTTP 429. The counter
  is in-memory and resets on restart.
- **Session invalidation.** Password changes and role changes revoke all of the
  affected user's sessions. Expired sessions are purged hourly.

## Authorization (RBAC)

| Role | Can view | Can mutate CI/CD resources |
|------|----------|----------------------------|
| `admin` | Everything | Everything + user management |
| `devops` | Everything | Repos, actions, scripts, secrets, machines (manage) |
| `developer` | repos, scripts, logs, status, machines (list for selection) | Actions (create/edit/run), own profile only |

All `/api/*` routes (except `/api/auth/login`, `/api/auth/me`) require a valid session.
Mutation routes use `requireStaff` (admin/devops) or `requireAdminUser` (user management).
Action create/edit (`PUT .../actions/:keyword`) and manual runs are open to all
authenticated users (action **deletion** stays staff-only); deployment-machine CRUD is
staff-only, though every user may list machines to pick deployment targets.
The bootstrap `admin` user cannot be deleted or demoted, and no user can delete/demote
themselves.

The dashboard mirrors this model in the UI: **Audit**, **Settings**, **Machines**,
and **Users** tabs are hidden from `developer` accounts, and shown to both
`admin` and `devops`.
Tab visibility is presentation-only — every protected API remains server-enforced
(user-management endpoints stay admin-only regardless of the tab being visible).

## Webhook Verification

Every webhook is signature-checked against the repo's per-repo `webhook_secret` using
constant-time comparison. Unsigned or mismatched requests are rejected with HTTP 401.

| Provider | Header |
|----------|--------|
| GitHub | `X-Hub-Signature-256: sha256=…` |
| Gitea / Forgejo | `X-Gitea-Signature` / `X-Forgejo-Signature` |
| GitLab | `X-Gitlab-Token` (shared secret) |
| Generic | `X-Webhook-Secret`, `X-Hub-Signature-256`, or `X-Signature-256` |

The secret is stored in the SQLite DB and never returned in full by `GET /api/repos`.
Staff can reveal it via `POST /api/repos/:id/reveal-secret` - every reveal is audited.

## Secret Storage

- Webhook secrets and git tokens are stored in the SQLite database file (`data/at-field-ci.db`).
- Uploaded SSH keys are additionally encrypted at rest (AES-256-GCM, see "SSH Key
  Management" below).
- API responses expose only a masked hint (`••••abcd`) and only to staff.
- Protect the DB file with filesystem permissions (`600` where possible) and encrypt
  the volume at rest in production. Do not commit `data/` (already in `.gitignore`).

## Command & Path Safety

- **Action scripts** run locally via `spawn('bash', [scriptPath])` with an **args
  array** - never `shell: true`, never string interpolation of user input - and are
  additionally streamed to each deployment machine over SSH (`ssh … bash -s`, run
  from `cd /tmp`). Script content goes over the SSH channel, never through a shell
  string; exported `CI_*` env values are single-quote-escaped.
- **SSH/rsync deploys** use `spawn()` with array args. Machine host and user are
  validated against `/^[a-zA-Z0-9._:-]+$/` and `/^[a-zA-Z0-9._-]+$/` when a machine
  is registered, and re-validated in the job runner before every connection.
- **Script names** are validated (alnum + `_`/`-`, no `..` or `/`), and resolved
  paths are checked to be within `scripts/`.
- **Log files** are sandboxed in `logs/`; filenames with `..`, `/`, or `\` are rejected.
- **rsync source** is resolved and must stay within the app directory.

## Input Validation

- Keywords: `/^[A-Z0-9_]+$/i`, max 100 chars.
- Script names: `/^[a-zA-Z0-9_-]+$/`, max 100 chars.
- Usernames: `/^[a-zA-Z0-9_.-]{2,64}$/`.
- Repo `full_name`: `owner/repo` shape, max 200 chars.
- `clone_url` must be `http(s)://…`; git tokens capped at 500 chars.
- Body size limits: webhook raw body 5 MB, JSON API 2 MB.

## Audit Log

All security-relevant actions are recorded in `audit_log` with the acting user, IP
(via `X-Forwarded-For` when behind a proxy), and a JSON details blob. Viewable at
`GET /api/audit` (staff only). Tracked events include login, login_failed, logout,
user/role changes, repo create/update/delete, secret reveals, action runs, and
webhook/poll queueing.

## HTTP Security Headers

The server sets on every response:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (prevents clickjacking)
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store`
- `X-Powered-By` is disabled.

The dashboard is a same-origin SPA with no `innerHTML` of untrusted data - all
server-derived values are escaped with `escapeHtml()` before insertion, and log
content is rendered via `textContent`.

## Deployment Hardening

### Required for production

1. **HTTPS reverse proxy.** Run behind Caddy, Traefik, or nginx for TLS termination.
   Set `COOKIE_SECURE=1` so session cookies get the `Secure` flag.

   ```
   at-field-ci.example.com {
     reverse_proxy localhost:3000
   }
   ```

2. **Strong bootstrap credentials.** Set `ADMIN_USER`/`ADMIN_PASSWORD` (≥16 chars) in
   `.env` or docker-compose before first boot. The admin is created only when the DB
   has zero users.

3. **File permissions.** `data/`, `logs/`, `ssh/` should be `700`/`600`. The Docker
   image mounts SSH keys read-only.

4. **Docker resource limits.** `docker-compose.yml` caps at 2 CPUs / 512 MB RAM with
   `restart: unless-stopped` and 10 MB × 3 log file rotation.

### Docker hardening checklist

- [x] `restart: unless-stopped`
- [x] Resource limits (2 CPU, 512 MB)
- [x] Health check
- [x] SSH keys mounted read-only (`:ro`)
- [x] Log rotation (10 MB, 3 files)
- [ ] Run as a non-root user (add `user:` to compose if your image supports it)
- [ ] Isolated Docker network (don't expose to the public network directly)

## SSH Key Management

Private keys are uploaded through the **Machines** tab (staff only) and referenced
by machines by name. The key content never leaves the API as plaintext:

- Uploaded keys are checked to contain a private-key header (`PRIVATE KEY`),
  capped at 16 KB, and stored **AES-256-GCM encrypted at rest** in `ssh_keys`.
- The encryption master key is `MASTER_KEY` (64 hex chars) if set, otherwise an
  auto-generated `data/master.key` file (mode `600`). **Back up `master.key`
  together with the DB** — losing it makes stored keys undecryptable.
- During a job run the key is decrypted to a temporary `0600` file under the OS
  temp dir for that machine's deploy + script only, then deleted. Keys are never
  logged and never returned by any API.

Machines also have an **SSH port** (default 22) applied to `ssh`/`rsync`
connections. Host keys should still be pinned via `ssh_options`
(e.g. `-o StrictHostKeyChecking=accept-new` with a known_hosts file).

## What AT FIELD CICD does NOT protect against

- **Network sniffing** - use an HTTPS reverse proxy.
- **Secrets you print in scripts** - scripts run with `CI_*` env vars; don't echo them.
- **Compromised SSH keys or dashboard credentials** - rotate regularly.
- **Malicious scripts you author** - AT FIELD CICD runs exactly what you configure.

## Reporting a Vulnerability

Report security issues privately to the maintainers. Do not open a public issue.
If a fix is available, allow up to 90 days for a coordinated disclosure before
publishing details.

## Dependency Audits

Run `npm audit` before each release. The project has no runtime dev dependencies.
Keep `better-sqlite3`, `express`, `js-yaml`, and `dotenv` pinned and patched.

## License

AT FIELD CICD is released under the [MIT License](LICENSE). Security considerations
under that license: the software is provided "as is", without warranty of any kind.

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [CWE-22: Path Traversal](https://cwe.mitre.org/data/definitions/22.html)
- [CWE-78: OS Command Injection](https://cwe.mitre.org/data/definitions/78.html)
- [CWE-916: Password Hash With Insufficient Cost](https://cwe.mitre.org/data/definitions/916.html)
- [CWE-200: Information Exposure](https://cwe.mitre.org/data/definitions/200.html)
