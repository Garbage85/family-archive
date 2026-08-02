#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf 'ПРИМЕЧАНИЕ: scripts/deploy-update.sh устарел; запускаю update-server.sh.\n' >&2
exec "$SCRIPT_DIR/update-server.sh" "$@"
