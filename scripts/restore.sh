#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf 'ПРИМЕЧАНИЕ: scripts/restore.sh устарел; используйте --backup FILE --restore-data.\n' >&2
exec "$SCRIPT_DIR/rollback-server.sh" "$@"
