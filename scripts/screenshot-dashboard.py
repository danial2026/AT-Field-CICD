#!/usr/bin/env python3
"""
Regenerate the README screenshots for AT FIELD CICD.

Captures all ten dashboard tabs in tab order: dashboard, repos, scripts,
notifications, logs, machines, audit, settings, users, profile.
Output goes to screenshots/.

Setup (one time):
  pip install playwright
  python -m playwright install chromium

Run:
  1. Seed the demo data and start the server:
       node scripts/seed-demo.js
       node server.js
  2. Capture (defaults match a fresh dev DB - admin / admin):
       python scripts/screenshot-dashboard.py

Env overrides:
  BASE_URL       default http://localhost:3000
  ADMIN_USER     default admin
  ADMIN_PASS     default admin
  VIEWPORT_W     1280
  VIEWPORT_H     800
  SCALE_FACTOR   2 (device scale / retina; 2 → sharp 2x images)
  CHROME_PATH    path to a Chrome/Chromium binary, used when Playwright's
                 bundled browser isn't available (e.g. offline machines)

Tip: widen the viewport (VIEWPORT_W=1920 VIEWPORT_H=1080) to "zoom out" the
tabs - more content fits per shot. SCALE_FACTOR only affects image sharpness.

Example:
  BASE_URL=http://localhost:3000 ADMIN_USER=admin ADMIN_PASS=secret \\
    VIEWPORT_W=1680 VIEWPORT_H=1050 python scripts/screenshot-dashboard.py
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = "screenshots"
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("ADMIN_PASS", "admin")
VIEWPORT_W = int(os.environ.get("VIEWPORT_W", "1680"))
VIEWPORT_H = int(os.environ.get("VIEWPORT_H", "1050"))
SCALE_FACTOR = float(os.environ.get("SCALE_FACTOR", "2"))
CHROME_PATH = os.environ.get("CHROME_PATH") or None


def shoot(page, name):
    """Save a screenshot and print a short log line."""
    page.screenshot(path=f"{OUT}/{name}.png")
    print(f"saved {name}.png")


def click_tab(page, tab):
    """Switch to a dashboard tab and wait for it to render."""
    page.click(f'button.tab-button[data-tab="{tab}"]')
    page.wait_for_selector(f"#{tab}-tab.active", timeout=5000)
    page.wait_for_timeout(700)


def main():
    os.makedirs(OUT, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME_PATH)
        ctx = browser.new_context(
            viewport={"width": VIEWPORT_W, "height": VIEWPORT_H},
            device_scale_factor=SCALE_FACTOR,
        )
        page = ctx.new_page()

        # Sign in (no login screenshot)
        page.goto(BASE + "/")
        page.wait_for_load_state("networkidle")
        page.fill("#login-username", ADMIN_USER)
        page.fill("#login-password", ADMIN_PASS)
        page.click("#login-submit")
        page.wait_for_selector("#dashboard-tab.active", timeout=8000)
        page.wait_for_timeout(900)

        # Dashboard (landing tab)
        shoot(page, "dashboard")

        # All remaining tabs in navigation order
        for tab in ("repos", "scripts", "notifications", "logs", "machines", "audit", "settings", "users", "profile"):
            try:
                click_tab(page, tab)
                shoot(page, tab)
            except Exception as e:
                print(f"{tab} skipped: {e}", file=sys.stderr)

        browser.close()

    print("done")


if __name__ == "__main__":
    main()
