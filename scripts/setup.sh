#!/usr/bin/env bash
# One-time setup of the Python side: venv, Playwright and Chromium (in rfp/.venv).
# On Linux/Docker run with PLAYWRIGHT_WITH_DEPS=1 to also install Chromium's system libraries.
set -euo pipefail
cd "$(dirname "$0")/../rfp"
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
if [[ -n "${PLAYWRIGHT_WITH_DEPS:-}" ]]; then
  .venv/bin/playwright install --with-deps chromium
else
  .venv/bin/playwright install chromium
fi
echo "rfp ready"
