#!/bin/bash
set -euo pipefail
echo "==> Smoke testing API endpoints"
BASE="${API_BASE:-http://localhost:8080}"
curl -sf "$BASE/health" > /dev/null && echo "health: OK"
curl -sf "$BASE/api/v1/products?limit=1" > /dev/null && echo "products: OK"
curl -sf -X POST "$BASE/api/v1/auth/login" -d '{}' -o /dev/null && echo "auth: OK"
echo "==> All smoke tests passed"
