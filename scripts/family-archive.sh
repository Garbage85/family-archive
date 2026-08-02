#!/usr/bin/env bash
set -Eeuo pipefail

LAUNCHER_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$LAUNCHER_PATH")" && pwd)"

usage() {
  cat <<'EOF'
Family Archive — управление серверной установкой.

Использование:
  family-archive COMMAND [опции]

Команды:
  install    Чистая установка из checkout репозитория
  update     Безопасное обновление release
  backup     Создание согласованного backup
  rollback   Переключение release или восстановление данных
  status     Краткий статус сервиса и установки
  doctor     Расширенная локальная диагностика
  logs       Журнал systemd-сервиса
  version    Версия текущего release

Совместимые имена:
  family-archive-update
  family-archive-backup
  family-archive-rollback
  family-archive-status
EOF
}

die() {
  printf 'ОШИБКА: %s\n' "$*" >&2
  exit 1
}

run_privileged_script() {
  local script=$1
  shift
  [[ -x $script ]] || die "Команда недоступна в текущем release: $script"
  if (( EUID == 0 )); then
    exec "$script" "$@"
  fi
  command -v sudo >/dev/null 2>&1 || die "Не найдена команда sudo."
  exec sudo -- "$script" "$@"
}

case "${0##*/}" in
  family-archive-update) COMMAND=update ;;
  family-archive-backup) COMMAND=backup ;;
  family-archive-rollback) COMMAND=rollback ;;
  family-archive-status) COMMAND=status ;;
  family-archive)
    if (($# == 0)); then
      usage
      exit 0
    fi
    COMMAND=$1
    shift
    ;;
  *)
    if (($# == 0)); then
      usage
      exit 0
    fi
    COMMAND=$1
    shift
    ;;
esac

case "$COMMAND" in
  install) run_privileged_script "$SCRIPT_DIR/install-server.sh" "$@" ;;
  update) run_privileged_script "$SCRIPT_DIR/update-server.sh" "$@" ;;
  backup) run_privileged_script "$SCRIPT_DIR/backup-server.sh" "$@" ;;
  rollback) run_privileged_script "$SCRIPT_DIR/rollback-server.sh" "$@" ;;
  status) run_privileged_script "$SCRIPT_DIR/status-server.sh" "$@" ;;
  doctor) run_privileged_script "$SCRIPT_DIR/doctor-server.sh" "$@" ;;
  logs) run_privileged_script "$SCRIPT_DIR/logs-server.sh" "$@" ;;
  version) run_privileged_script "$SCRIPT_DIR/version-server.sh" "$@" ;;
  -h|--help|help) usage ;;
  *) die "Неизвестная команда: $COMMAND. Используйте family-archive --help." ;;
esac
