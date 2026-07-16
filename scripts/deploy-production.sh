#!/usr/bin/env bash
# Safe, immutable Silicon Interface production deploy.
#
# Preview only:
#   bash scripts/deploy-production.sh --dry-run
#
# Deploy interface.teamofsilicons.com:
#   bash scripts/deploy-production.sh --confirm-production

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/deploy-production.mjs" "$@"
