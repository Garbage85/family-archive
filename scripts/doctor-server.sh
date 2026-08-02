#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Расширенная локальная диагностика Family Archive без изменения установки.

Использование:
  sudo ./scripts/doctor-server.sh [--config FILE]

Опции:
  --config FILE   Deployment-конфигурация
  -h, --help      Показать справку
EOF
}

PASSED=0
WARNINGS=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  printf 'PASS  %s\n' "$1"
}

warning() {
  WARNINGS=$((WARNINGS + 1))
  printf 'WARN  %s\n' "$1"
}

failure() {
  FAILED=$((FAILED + 1))
  printf 'FAIL  %s\n' "$1"
}

exit_if_help_requested usage "$@"
preparse_config "$@"
load_config
while (($#)); do
  case "$1" in
    --config) shift 2 ;;
    --config=*) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done

setup_traps
require_root

REQUIRED_COMMANDS=(awk basename curl cut df dirname find getent grep head journalctl readlink runuser sed sha256sum sort ss systemctl)
for command_name in "${REQUIRED_COMMANDS[@]}"; do
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "Команда доступна: $command_name"
  else
    failure "Команда не найдена: $command_name"
  fi
done
if (( FAILED )); then
  printf '\nИтог doctor: PASS=%s WARN=%s FAIL=%s\n' "$PASSED" "$WARNINGS" "$FAILED"
  exit 1
fi

CURRENT_RELEASE="$(current_release 2>/dev/null || true)"
if [[ -n $CURRENT_RELEASE ]]; then
  pass "Текущий release целостен: $CURRENT_RELEASE"
else
  failure "Текущий release отсутствует, неполон или находится вне releases."
fi

if [[ -d $INSTALL_ROOT/shared/pb_data ]]; then
  pass "Каталог данных существует: $INSTALL_ROOT/shared/pb_data"
else
  failure "Каталог данных не найден: $INSTALL_ROOT/shared/pb_data"
fi

if command -v getent >/dev/null 2>&1 && getent passwd "$SERVICE_USER" >/dev/null; then
  pass "Системный пользователь существует: $SERVICE_USER"
else
  failure "Системный пользователь не найден: $SERVICE_USER"
fi

if command -v runuser >/dev/null 2>&1 && [[ -d $INSTALL_ROOT/shared/pb_data ]] &&
  runuser -u "$SERVICE_USER" -- test -r "$INSTALL_ROOT/shared/pb_data" &&
  runuser -u "$SERVICE_USER" -- test -w "$INSTALL_ROOT/shared/pb_data"; then
  pass "Пользователь $SERVICE_USER может читать и писать pb_data."
else
  failure "Пользователь $SERVICE_USER не может читать или писать pb_data."
fi

if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  pass "systemd unit существует: $SERVICE_NAME"
else
  failure "systemd unit не найден: $SERVICE_NAME"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled --quiet "$SERVICE_NAME"; then
  pass "systemd unit включён."
else
  warning "systemd unit не включён."
fi
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE_NAME"; then
  pass "systemd service active."
else
  failure "systemd service не active."
fi

if command -v ss >/dev/null 2>&1 && port_is_listening; then
  pass "TCP-порт $(listen_port) слушается."
else
  failure "TCP-порт $(listen_port) не слушается."
fi
HTTP_CODE="$(http_status_code /)"
if [[ $HTTP_CODE == 200 ]]; then
  pass "HTTP / отвечает 200."
else
  failure "HTTP / отвечает '${HTTP_CODE:-ошибка}' вместо 200."
fi
if api_health_ok; then
  pass "PocketBase API health доступен."
else
  failure "PocketBase API health недоступен."
fi

if command -v df >/dev/null 2>&1; then
  AVAILABLE_KB="$(df -Pk "$INSTALL_ROOT" 2>/dev/null | awk 'NR == 2 {print $4}' || true)"
  REQUIRED_KB=$((MIN_FREE_MB * 1024))
  if [[ $AVAILABLE_KB =~ ^[0-9]+$ ]] && (( AVAILABLE_KB >= REQUIRED_KB )); then
    pass "Свободного места не меньше ${MIN_FREE_MB} MiB."
  else
    failure "Свободного места меньше ${MIN_FREE_MB} MiB или его не удалось определить."
  fi
fi

LATEST_BACKUP="$(find "$INSTALL_ROOT/backups" -maxdepth 1 -type f -name 'family-archive-*.tar.gz' \
  -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2- || true)"
if [[ -z $LATEST_BACKUP ]]; then
  warning "Backup не найден."
elif [[ ! -f $LATEST_BACKUP.sha256 ]]; then
  failure "У последнего backup нет checksum: $LATEST_BACKUP.sha256"
elif (cd "$(dirname "$LATEST_BACKUP")" && sha256sum --check --status "$(basename "$LATEST_BACKUP").sha256"); then
  pass "Checksum последнего backup корректен: $LATEST_BACKUP"
else
  failure "Checksum последнего backup не совпадает: $LATEST_BACKUP"
fi

CLI_TARGET="$INSTALL_ROOT/current/scripts/family-archive.sh"
if [[ -L /usr/local/bin/family-archive && $(readlink /usr/local/bin/family-archive) == "$CLI_TARGET" ]]; then
  pass "Launcher установлен: /usr/local/bin/family-archive"
else
  warning "Launcher отсутствует или указывает не на текущую установку."
fi
for compatibility_command in update backup rollback status; do
  compatibility_path="/usr/local/bin/family-archive-$compatibility_command"
  if [[ -L $compatibility_path && $(readlink "$compatibility_path") == family-archive ]]; then
    pass "Совместимая команда установлена: $compatibility_path"
  else
    warning "Совместимая команда отсутствует: $compatibility_path"
  fi
done

printf '\nИтог doctor: PASS=%s WARN=%s FAIL=%s\n' "$PASSED" "$WARNINGS" "$FAILED"
(( FAILED == 0 ))
