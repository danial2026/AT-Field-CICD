# AT FIELD CICD

![Version](https://img.shields.io/badge/version-0.0.2-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

CI/CD platform with a web dashboard. Builds, tests, and deploys with strong isolation and controlled pipelines - like an Absolute Terror Field for your projects

## Screenshots

<table>
  <tr>
    <td align="center"><b>Login Screen</b><br><img src="screenshots/login.png" width="400"></td>
    <td align="center"><b>Dashboard View</b><br><img src="screenshots/dashboard.png" width="400"></td>
  </tr>
  <tr>
    <td align="center"><b>Repositories</b><br><img src="screenshots/repos.png" width="400"></td>
    <td align="center"><b>Script Manager</b><br><img src="screenshots/scripts.png" width="400"></td>
  </tr>
  <tr>
    <td align="center"><b>Notifications</b><br><img src="screenshots/notifications.png" width="400"></td>
    <td align="center"><b>Build Logs</b><br><img src="screenshots/logs.png" width="400"></td>
  </tr>
  <tr>
    <td align="center"><b>Audit Trail</b><br><img src="screenshots/audit.png" width="400"></td>
    <td align="center"><b>Settings Page</b><br><img src="screenshots/settings.png" width="400"></td>
  </tr>
  <tr>
    <td align="center"><b>Users &amp; Roles</b><br><img src="screenshots/users.png" width="400"></td>
    <td align="center"><b>Profile Page</b><br><img src="screenshots/profile.png" width="400"></td>
  </tr>
</table>

## Quick Start

```bash
cp .env.example .env          # set ADMIN_USER / ADMIN_PASSWORD
docker-compose up -d          # dashboard at http://localhost:3000
```

Point a repo webhook at `http://your-host:3000/webhook/<slug>`.

## How It Works

1. A push lands (webhook or poll catch-up).
2. Commit messages are scanned for keywords you defined per-repo.
3. Matching actions run one at a time through a serial queue, each with its own log.

**Actions:** `script` (run a `.sh`), `deploy` via `rsync`, or `deploy` via `ssh`.

## Security

- scrypt password hashing, HttpOnly `SameSite=Strict` session cookies
- Per-repo webhook signature verification (HMAC-SHA256 / token)
- RBAC: `admin` / `devops` / `developer`
- `spawn()` with array args - no shell injection; path-traversal guards everywhere
- HTTP headers: `nosniff`, `DENY` framing, `no-store`, `no-referrer`

See [SECURITY.md](SECURITY.md) for the full model and hardening checklist.

## Development

```bash
npm install
npm start                                  # node server.js
python3 scripts/screenshot-dashboard.py    # regenerate screenshots
bash test-smoke.sh                          # smoke tests
```

## License

[MIT](LICENSE) - © 2026 danial

## AI Assistance

Parts of this project were developed with assistance from DeepSeek.
