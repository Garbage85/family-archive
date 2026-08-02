#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Журнал systemd-сервиса Family Archive.

Использование:
  sudo ./scripts/logs-server.sh [--lines N] [--follow] [--config FILE]

Опции:
  --lines N      Число последних строк (по умолчанию 100)
  -f, --follow   Продолжать вывод новых записей
  --config FILE  Deployment-конфигурация
  -h, --help     Показать справку
EOF
}

LINES=100
FOLLOW=0

exit_if_help_requested usage "$@"
preparse_config "$@"
load_config
while (($#)); do
  case "$1" in
    --lines) [[ $# -ge 2 ]] || die "Для --lines требуется число."; LINES=$2; shift 2 ;;
    --lines=*) LINES=${1#*=}; shift ;;
    -f|--follow) FOLLOW=1; shift ;;
    --config) shift 2 ;;
    --config=*) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done
validate_positive_integer LINES "$LINES"

setup_traps
require_root
require_commands journalctl systemctl
systemctl cat "$SERVICE_NAME" >/dev/null 2>&1 || die "systemd unit не найден: $SERVICE_NAME"

JOURNAL_ARGS=(-u "$SERVICE_NAME" -n "$LINES" --no-pager)
(( FOLLOW )) && JOURNAL_ARGS+=(--follow)
exec journalctl "${JOURNAL_ARGS[@]}"
