#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf 'ПРИМЕЧАНИЕ: scripts/backup.sh устарел; запускаю backup-server.sh.\n' >&2
exec "$SCRIPT_DIR/backup-server.sh" "$@"
