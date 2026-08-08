#!/usr/bin/env python3
"""
Regenerate the README screenshots for AT Field CI.

Grabs one shot per dashboard tab: login, repos (dashboard), scripts, logs,
and audit. Output goes to screenshots/.

Setup (one time):
  pip install playwright
  python -m playwright install chromium

Run:
  1. Start the server:
       node server.js
  2. Capture (defaults match a fresh dev DB - admin / admin):
       python scripts/screenshot-dashboard.py

Env overrides:
  BASE_URL       default http://localhost:3000
  ADMIN_USER     default admin
  ADMIN_PASS     default admin
  CHROME_PATH    path to a Chrome/Chromium binary, used when Playwright's
                 bundled browser isn't available (e.g. offline machines)

Example:
  BASE_URL=http://localhost:3000 ADMIN_USER=admin ADMIN_PASS=secret \\
    python scripts/screenshot-dashboard.py
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = "screenshots"
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("ADMIN_PASS", "admin")
CHROME_PATH = os.environ.get("CHROME_PATH") or None


def shoot(page, name):
    """Save a screenshot and print a short log line."""
    page.screenshot(path=f"{OUT}/{name}.png")
    print(f"saved {name}.png")


def click_tab(page, tab):
    """Switch to a dashboard tab and wait for it to render."""
    page.click(f'button.tab-button[data-tab="{tab}"]')
    page.wait_for_selector(f"#{tab}-tab:not(.hidden)", timeout=5000)
    page.wait_for_timeout(700)


def main():
    os.makedirs(OUT, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME_PATH)
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 800},
            device_scale_factor=2,
        )
        page = ctx.new_page()

        # Login screen
        page.goto(BASE + "/")
        page.wait_for_load_state("networkidle")
        page.wait_for_selector("#login-page:not(.hidden)", timeout=8000)
        page.wait_for_timeout(600)
        shoot(page, "login")

        # Sign in
        page.fill("#login-username", ADMIN_USER)
        page.fill("#login-password", ADMIN_PASS)
        page.click("#login-submit")
        page.wait_for_selector("#repos-tab:not(.hidden)", timeout=8000)
        page.wait_for_timeout(900)

        # Dashboard (repos tab is the default landing)
        shoot(page, "dashboard")

        # Scripts / Logs / Audit
        for tab in ("scripts", "logs", "audit"):
            try:
                click_tab(page, tab)
                shoot(page, tab)
            except Exception as e:
                print(f"{tab} skipped: {e}", file=sys.stderr)

        browser.close()

    print("done")


if __name__ == "__main__":
    main()
