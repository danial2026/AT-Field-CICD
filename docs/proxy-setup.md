# Server Proxy Setup — Fixing GitHub access on a filtered connection

> **Proxy scripts version:** `1.0.0` · **App version:** `0.0.1`
> Scripts: `scripts/proxy/mac-setup-tinyproxy.sh`,
> `scripts/proxy/server-setup-proxy.sh`, `scripts/proxy/server-remove-proxy.sh`

This document explains why `git clone` was hanging on the Ubuntu home server,
how it was fixed during the session, exactly what was changed on each machine,
and how to set it up or tear it down yourself using the scripts in
`scripts/proxy/`.

---

## 1. The problem

The server is on an ISP that applies **DPI (deep packet inspection)** filtering
on HTTPS traffic to sites like `github.com`: the TCP connection opens, but the
TLS handshake stalls, so `git clone https://github.com/...` hangs forever until
you press `Ctrl+C`.

The filtering is **intermittent** — a test `curl` sometimes returns `200`
— which is exactly why a one-off "does it work now?" check is unreliable but
a real `git clone` still hangs.

The laptop, meanwhile, runs a VPN client which routes GitHub through a VPN
tunnel. So the laptop reaches GitHub fine; the server does not.

---

## 2. The solution (architecture)

```
  Ubuntu server                              Mac laptop
  ┌────────────────────────┐              ┌────────────────────────┐
  │ git                    │              │ VPN client             │
  │ docker daemon          │  HTTP proxy  │   tunnel (utun4)       │
  │ at-field-ci container  │  request     │ tinyproxy :8888        │
  │  (git clone in builds) │─────────────►│   (LAN-facing HTTP)    │
  └───────────┬────────────┘              └────────────────────────┘
              │                                        │
         Filtered ISP                             VPN exit
        (GitHub blocked)                       (unfiltered)
```

We install **tinyproxy** on the Mac (a tiny HTTP proxy). Its outbound traffic
follows the Mac's normal routing — which, for GitHub, goes through the VPN
tunnel. We then point the server's `git`, the Docker daemon, and the CI
container at the proxy. Everything that was hanging now flows through the Mac's
VPN.

Why an HTTP proxy and not a SOCKS proxy: `git`, `docker`, `npm`, and `apt` all
understand `HTTP_PROXY`/`HTTPS_PROXY` natively, so no extra bridging software is
needed.

---

## 3. What was changed during the session (who / what / why)

### A. On the Mac — the laptop

| Command | Why |
|---|---|
| `brew install tinyproxy` | Install a small LAN-facing HTTP proxy. |
| Edited tinyproxy.conf: added `Allow <your-lan-subnet>` | Permit devices on the home LAN to use the proxy (default only allows `127.0.0.1`). `Listen` was left commented out so it binds to all interfaces. |
| `brew services start tinyproxy` | Run it as a background service that auto-restarts at login. |
| `curl -x http://127.0.0.1:8888 https://github.com` → `200` | Verify the proxy works and reaches GitHub through the VPN. |
| `curl -x http://<your-mac-lan-ip>:8888 https://github.com` → `200` | Verify it's reachable on the LAN IP (catches firewall issues). |
| `route -n get <github-ip>` → `interface: utun4` | Confirmed the Mac actually routes GitHub through the VPN (not directly via the ISP). |

### B. On the Ubuntu server — over SSH

| Command | Why |
|---|---|
| `curl https://github.com` (direct) → `200` | Showed the block is intermittent (sometimes works, but clones still hang). |
| `git config --global http.proxy http://<your-mac-lan-ip>:8888` + `https.proxy` | Make all host-level `git` operations go through the proxy. |
| `git config --global http.version HTTP/1.1` | Force HTTP/1.1 (some proxies/DPI choke on HTTP/2 multiplexing). |
| `timeout 120 git clone <your-repo-url>` | The actual fix — **clone succeeded** through the proxy. |
| Added `no_proxy`/`NO_PROXY` to `~/.zshrc` | Keep LAN traffic direct (don't accidentally proxy local services). |
| Created `docker-compose.override.yml` with `HTTP_PROXY`/`HTTPS_PROXY` env | The CI platform runs in a container and spawns `git clone` inside build scripts; the container needs the proxy env too. This file is auto-merged by docker-compose and is **not** tracked by git. |
| `docker-compose config` (checked merged env) | Confirmed the proxy env is present in the effective config. |
| `docker run ... curl -x ... https://github.com` → `200` | Verified a container on the bridge network can actually reach the proxy. |

### C. NOT yet done (needs your sudo password)

The Docker **daemon** itself (used by `docker pull` and `docker build` to fetch
base images like `node:20-alpine`, and by `apk add`/`npm ci` inside the build)
needs a systemd drop-in to use the proxy. Sudo requires your password, which I
can't enter. This is the one remaining manual step (see §5).

---

## 4. How to set it up from scratch (using the scripts)

There are three scripts in `scripts/proxy/` (all `v1.0.0`):

| Script | Runs on | What it does |
|---|---|---|
| `mac-setup-tinyproxy.sh` | **Mac** | Installs + configures + starts tinyproxy, verifies end-to-end. |
| `server-setup-proxy.sh` | **Server** | Configures git, shell env, docker-compose override, and Docker daemon. |
| `server-remove-proxy.sh` | **Server** | Removes everything the setup script did. |

All three are production-hardened: `set -euo pipefail`, OS guards (Mac vs
Linux), lock files to prevent concurrent runs, backups before modifying any
config, atomic writes (temp file → `mv`), pre-flight reachability checks,
post-flight verification, rollback on failure (setup script), idempotency, and
a `DRY_RUN=1` mode. Each supports `--help` and `--version`.

### Step 1 — On the Mac (once)

```bash
bash scripts/proxy/mac-setup-tinyproxy.sh
```

Make sure your **VPN is connected** first — tinyproxy only forwards traffic;
the VPN does the unblocking. The script will prompt for your LAN subnet (or set
`LAN_SUBNET` in the environment). It prints the proxy URL to give to the server
(e.g. `http://<your-mac-lan-ip>:8888`).

### Step 2 — On the server (once)

```bash
cd /path/to/your/repo
bash scripts/proxy/server-setup-proxy.sh
```

The script will prompt for your Mac's LAN IP (or set `PROXY_HOST` in the
environment). It will also prompt for your sudo password when configuring the
Docker daemon.

```bash
PROXY_HOST=<your-mac-lan-ip> PROXY_PORT=8888 bash scripts/proxy/server-setup-proxy.sh
```

Other options: `DRY_RUN=1` (show actions, change nothing), `FORCE=1` (skip the
pre-flight reachability check), `--help`, `--version`.

### Step 3 — Build & start the platform

```bash
cp .env.example .env        # edit ADMIN_USER / ADMIN_PASSWORD
docker-compose up -d --build
docker exec at-field-ci git ls-remote "$TEST_GIT_REPO" HEAD
```

---

## 5. The one manual step (Docker daemon) — if you can't run the script

If you prefer to do the Docker daemon part by hand, run this on the server:

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf >/dev/null <<'EOF'
[Service]
Environment="HTTP_PROXY=http://<your-mac-lan-ip>:8888"
Environment="HTTPS_PROXY=http://<your-mac-lan-ip>:8888"
Environment="NO_PROXY=localhost,127.0.0.1,<your-lan-subnet>"
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

---

## 6. How to undo / remove the proxy from the server

```bash
cd /path/to/your/repo
bash scripts/proxy/server-remove-proxy.sh
```

This removes:
- `git config --global` proxy entries,
- the `no_proxy` block from `~/.zshrc` and `~/.bashrc`,
- `docker-compose.override.yml`,
- the Docker daemon drop-in (needs sudo), and restarts Docker.

After this the server uses its direct connection again — GitHub may start
hanging once more.

### To undo on the Mac (stop sharing the proxy):

```bash
brew services stop tinyproxy
brew uninstall tinyproxy
```

---

## 7. Caveats & troubleshooting

- **The Mac must be on and the VPN connected.** If either is down, the server's
  `git`/`docker` will fail (the proxy won't bypass anything). tinyproxy itself
  auto-starts at login via `brew services`.
- **The Mac IP is likely DHCP.** If the Mac's LAN IP changes, update it in three
  places: `git config --global`, `docker-compose.override.yml`, and the Docker
  daemon drop-in (`/etc/systemd/system/docker.service.d/http-proxy.conf`). Then
  `sudo systemctl restart docker`. Easiest: just re-run
  `server-setup-proxy.sh` with the new `PROXY_HOST`.
- **For truly unattended CI/CD (Mac off):** this setup won't help. You'd want a
  server-side proxy client (sing-box / Xray / v2ray) with your own subscription,
  running on the server itself. The current laptop-proxy approach is the
  simplest fix using what you already have.
- **If `git clone` still hangs** after setup: confirm the proxy is reachable
  from the server with `curl -x http://<your-mac-lan-ip>:8888 https://github.com`,
  and confirm the Mac's VPN is up with `curl https://github.com` on the Mac.
- **GitHub auth inside the container** uses the `CI_CLONE_AUTH_URL` / git token
  mechanism in `server.js`; that path now also flows through the proxy via the
  container env.
