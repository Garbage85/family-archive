#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf 'ПРИМЕЧАНИЕ: scripts/install.sh устарел; запускаю install-server.sh.\n' >&2
exec "$SCRIPT_DIR/install-server.sh" "$@"
