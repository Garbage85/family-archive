#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Установка Family Archive на Raspberry Pi / Debian.

Использование:
  sudo ./scripts/install-server.sh [опции]

Опции:
  --branch NAME          Ветка Git (по умолчанию main)
  --repo URL             URL репозитория
  --config FILE          Deployment-конфигурация
  --dry-run              Проверить clean layout и показать план без изменений
  --port PORT            HTTP-порт 1024–65535 (по умолчанию 8090)
  --site-name NAME       Отображаемое имя сайта
  --timezone ZONE        Часовой пояс приложения
  --no-systemd           Не создавать и не запускать systemd unit
  --yes                  Принять безопасные значения без мастера
  --admin-instructions   Показать безопасную инструкцию создания первого superuser
  -h, --help             Показать справку

Скрипт предназначен для чистой установки и откажется перезаписывать существующий
INSTALL_ROOT. Пароли и токены не принимаются ни через аргументы, ни через env.
EOF
}

BRANCH=${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_BRANCH:-}
REPO=${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_URL:-}
DRY_RUN=0
ASSUME_YES=0
PORT_EXPLICIT=0
SITE_NAME_EXPLICIT=0
TIMEZONE_EXPLICIT=0
NO_SYSTEMD_EXPLICIT=0
SHOW_ADMIN_INSTRUCTIONS=0
NEW_RELEASE=""
NEW_RELEASE_CREATED=0
UNIT_CREATED=0
CURRENT_SWITCHED=0
SERVICE_STARTED=0
INSTALL_LAYOUT_CREATED=0
SOURCE_DIR=""
RELEASE_STAGING=""
INSTALL_TEST_MODE=${FAMILY_ARCHIVE_INSTALL_TEST_MODE:-0}

install_failure_rollback() {
  local failed_root="" suffix=0
  set +e
  warn "Установка не завершена; откатываю созданные служебные объекты."
  (( SERVICE_STARTED )) && systemctl stop "$SERVICE_NAME"
  remove_created_cli_launchers
  if (( CURRENT_SWITCHED )) && [[ -L $INSTALL_ROOT/current ]]; then
    rm -f -- "$INSTALL_ROOT/current"
  fi
  if (( NEW_RELEASE_CREATED )) && [[ -n $NEW_RELEASE && -d $NEW_RELEASE && $NEW_RELEASE == "$INSTALL_ROOT/releases/"* ]]; then
    rm -rf -- "$NEW_RELEASE"
  fi
  if [[ -n $RELEASE_STAGING && -d $RELEASE_STAGING && $RELEASE_STAGING == "$INSTALL_ROOT/releases/.staging."* ]]; then
    rm -rf -- "$RELEASE_STAGING"
  fi
  if (( UNIT_CREATED )); then
    systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f -- "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
  fi
  if (( INSTALL_LAYOUT_CREATED )) && [[ -d $INSTALL_ROOT && ! -e $INSTALL_ROOT/current ]]; then
    failed_root="${INSTALL_ROOT}.failed-install-$(date +%Y%m%d-%H%M%S)"
    while [[ -e $failed_root ]]; do
      ((suffix += 1))
      failed_root="${INSTALL_ROOT}.failed-install-$(date +%Y%m%d-%H%M%S)-$suffix"
    done
    if mv "$INSTALL_ROOT" "$failed_root"; then
      warn "Незавершённая установка и pb_data сохранены: $failed_root"
    else
      warn "Не удалось переместить $INSTALL_ROOT; данные оставлены на месте."
    fi
  else
    warn "Каталог $INSTALL_ROOT/shared/pb_data автоматически не удалялся."
  fi
}

print_admin_instructions() {
  cat >&2 <<EOF

Первый superuser создаётся вручную без передачи пароля в process list:
  1. На своём компьютере откройте SSH-туннель:
       ssh -L ${PORT}:127.0.0.1:${PORT} USER@SERVER
  2. Откройте http://127.0.0.1:${PORT}/_/ и используйте одноразовую ссылку
     первоначальной настройки из журнала:
       sudo journalctl -u ${SERVICE_NAME} --no-pager | grep -i installer

Не передавайте пароль аргументом команде и не сохраняйте его в deployment.env.
EOF
}

read_with_default() {
  local destination=$1 prompt=$2 default=$3 answer
  read -r -p "$prompt [$default] " answer || exit 130
  printf -v "$destination" '%s' "${answer:-$default}"
}

read_yes_default() {
  local destination=$1 prompt=$2 answer
  read -r -p "$prompt [Y/n] " answer || exit 130
  case "$answer" in
    ''|y|Y|yes|YES|да|Да) printf -v "$destination" '%s' true ;;
    *) printf -v "$destination" '%s' false ;;
  esac
}

choose_install_port() {
  local candidate
  validate_port "$PORT"
  if (( PORT_EXPLICIT )); then
    require_available_port "$PORT"
    return
  fi
  if port_is_available "$PORT"; then
    return
  fi
  candidate=$(find_first_available_port 8091 8190) ||
    die "Порты 8090–8190 заняты; укажите свободный --port явно."
  PORT=$candidate
  printf 'Порт 8090 занят; выбран свободный порт %s.\n' "$PORT" >&2
}

prompt_for_port() {
  local answer
  while true; do
    read -r -p "HTTP-порт: [$PORT] " answer || exit 130
    answer=${answer:-$PORT}
    if ! (validate_port "$answer") 2>/dev/null; then
      printf 'Введите целый порт в диапазоне 1024–65535.\n' >&2
      continue
    fi
    if ! port_is_available "$answer"; then
      printf 'Порт %s занят:\n%s\n' "$answer" "$(port_listener_details "$answer")" >&2
      continue
    fi
    PORT=$answer
    return
  done
}

run_setup_wizard() {
  local answer
  printf '\nFamily Archive — первоначальная настройка\n\n'
  (( SITE_NAME_EXPLICIT )) || read_with_default SITE_NAME 'Имя сайта:' "$SITE_NAME"
  validate_site_name "$SITE_NAME"
  choose_install_port
  (( PORT_EXPLICIT )) || prompt_for_port
  (( TIMEZONE_EXPLICIT )) || read_with_default TIMEZONE 'Часовой пояс:' "$TIMEZONE"
  validate_timezone "$TIMEZONE"
  (( NO_SYSTEMD_EXPLICIT )) || read_yes_default ENABLE_SYSTEMD 'Создать и включить systemd-сервис?'
  printf '\nБудет установлено:\n\n- имя сайта: %s\n- каталог: %s\n- порт: %s\n- часовой пояс: %s\n- systemd: %s\n- репозиторий: %s\n- ветка: %s\n\n' \
    "$SITE_NAME" "$INSTALL_ROOT" "$PORT" "$TIMEZONE" \
    "$([[ $ENABLE_SYSTEMD == true ]] && printf да || printf нет)" "$REPOSITORY_URL" "$DEFAULT_BRANCH"
  read -r -p 'Продолжить установку? [Y/n] ' answer || exit 130
  case "$answer" in ''|y|Y|yes|YES|да|Да) ;; *) printf 'Установка отменена; изменений нет.\n'; exit 0 ;; esac
}

exit_if_help_requested usage "$@"
preparse_config "$@"
load_config
[[ -n ${FAMILY_ARCHIVE_BOOTSTRAP_SELECTED_INSTALL_ROOT:-} ]] &&
  INSTALL_ROOT=$FAMILY_ARCHIVE_BOOTSTRAP_SELECTED_INSTALL_ROOT

while (($#)); do
  case "$1" in
    --branch) [[ $# -ge 2 ]] || die "Для --branch требуется значение."; BRANCH=$2; shift 2 ;;
    --branch=*) BRANCH=${1#*=}; shift ;;
    --repo) [[ $# -ge 2 ]] || die "Для --repo требуется значение."; REPO=$2; shift 2 ;;
    --repo=*) REPO=${1#*=}; shift ;;
    --config) shift 2 ;;
    --config=*) shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --port) [[ $# -ge 2 ]] || die "Для --port требуется значение."; PORT=$2; PORT_EXPLICIT=1; shift 2 ;;
    --port=*) PORT=${1#*=}; PORT_EXPLICIT=1; shift ;;
    --site-name) [[ $# -ge 2 ]] || die "Для --site-name требуется значение."; SITE_NAME=$2; SITE_NAME_EXPLICIT=1; shift 2 ;;
    --site-name=*) SITE_NAME=${1#*=}; SITE_NAME_EXPLICIT=1; shift ;;
    --timezone) [[ $# -ge 2 ]] || die "Для --timezone требуется значение."; TIMEZONE=$2; TIMEZONE_EXPLICIT=1; shift 2 ;;
    --timezone=*) TIMEZONE=${1#*=}; TIMEZONE_EXPLICIT=1; shift ;;
    --no-systemd) ENABLE_SYSTEMD=false; NO_SYSTEMD_EXPLICIT=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --admin-instructions) SHOW_ADMIN_INSTRUCTIONS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done

[[ -n $BRANCH ]] && DEFAULT_BRANCH=$BRANCH
[[ -n $REPO ]] && REPOSITORY_URL=$REPO
validate_config
if [[ -t 0 && $ASSUME_YES == 0 ]]; then
  run_setup_wizard
else
  choose_install_port
fi
validate_config

setup_traps
if (( INSTALL_TEST_MODE )); then
  (( DRY_RUN )) || die "Installer test mode разрешён только с --dry-run."
  [[ $INSTALL_ROOT == "${TMPDIR:-/tmp}"/* ]] || die "Installer test root должен находиться внутри TMPDIR."
else
  require_root
fi
require_commands apt-get dpkg-query grep awk sed find cut sort head runuser sleep df
pocketbase_arch_for "$(uname -m)" >/dev/null

if [[ -L $INSTALL_ROOT ]]; then
  die "$INSTALL_ROOT является симлинком; чистая установка остановлена."
fi
if [[ -e $INSTALL_ROOT ]]; then
  [[ -d $INSTALL_ROOT ]] || die "$INSTALL_ROOT существует и не является каталогом."
  if [[ -n $(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null) ]]; then
    if [[ -f $INSTALL_ROOT/pocketbase && -d $INSTALL_ROOT/pb_data ]]; then
      die "Обнаружена legacy-установка. Выполните: sudo ./scripts/migrate-legacy-server.sh --legacy-root $INSTALL_ROOT --install-root $INSTALL_ROOT --repo $REPOSITORY_URL --branch $DEFAULT_BRANCH"
    fi
    die "$INSTALL_ROOT уже содержит файлы; чистая установка остановлена."
  fi
fi
if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  die "systemd unit '$SERVICE_NAME' уже существует; чистая установка остановлена."
fi

check_free_space "$(dirname "$INSTALL_ROOT")"
if (( DRY_RUN )); then
  printf 'Dry-run: изменений не выполнено.\nДействие: чистая установка.\n'
  printf 'Install root: %s\nRepository: %s\nBranch: %s\n' \
    "$INSTALL_ROOT" "$REPOSITORY_URL" "$DEFAULT_BRANCH"
  printf 'Site name: %s\nPort: %s\nTimezone: %s\nSystemd: %s\n' \
    "$SITE_NAME" "$PORT" "$TIMEZONE" "$ENABLE_SYSTEMD"
  exit 0
fi

install_missing_system_packages
check_node_version

ROLLBACK_HANDLER=install_failure_rollback
log "Создаю системного пользователя и структуру каталогов."
getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$INSTALL_ROOT/shared" \
    --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
elif [[ $(getent passwd "$SERVICE_USER" | cut -d: -f7) != /usr/sbin/nologin ]]; then
  die "Существующий пользователь $SERVICE_USER имеет login shell; исправьте его вручную на /usr/sbin/nologin."
fi
mkdir -p "$INSTALL_ROOT/app" "$INSTALL_ROOT/releases" "$INSTALL_ROOT/shared/pb_data" \
  "$INSTALL_ROOT/backups"
INSTALL_LAYOUT_CREATED=1
chmod 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/app" "$INSTALL_ROOT/releases"
chmod 0750 "$INSTALL_ROOT/shared" "$INSTALL_ROOT/shared/pb_data"
chmod 0700 "$INSTALL_ROOT/backups"
chown "root:$SERVICE_GROUP" "$INSTALL_ROOT/shared"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_ROOT/shared/pb_data"

acquire_update_lock
prepare_repository_cache
COMMIT="$(resolve_cached_commit "" "$DEFAULT_BRANCH")"
SHORT_COMMIT=${COMMIT:0:12}
RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-$SHORT_COMMIT"

make_temp_dir SOURCE_DIR 'family-archive-install-source.XXXXXX'
checkout_cached_source "$COMMIT" "$SOURCE_DIR/repository"
log "Проверяю frontend для commit $COMMIT."
run_frontend_checks "$SOURCE_DIR/repository"
validate_migrations "$SOURCE_DIR/repository/pb_migrations"

make_temp_dir RELEASE_STAGING "$INSTALL_ROOT/releases/.staging.XXXXXX"
assemble_release "$SOURCE_DIR/repository" "$RELEASE_STAGING" "$COMMIT" \
  "$DEFAULT_BRANCH" "$DEFAULT_BRANCH"
NEW_RELEASE="$INSTALL_ROOT/releases/$RELEASE_ID"
[[ ! -e $NEW_RELEASE ]] || die "Release уже существует: $NEW_RELEASE"
mv "$RELEASE_STAGING" "$NEW_RELEASE"
NEW_RELEASE_CREATED=1

write_install_config "/etc/family-tree/deployment.env"
install -m 0600 "/etc/family-tree/deployment.env" "$INSTALL_ROOT/shared/deployment.env"
if [[ $ENABLE_SYSTEMD == true ]]; then
  write_systemd_unit "/etc/systemd/system/${SERVICE_NAME}.service"
  UNIT_CREATED=1
fi

log "Применяю проверенные миграции к shared/pb_data."
apply_migrations "$NEW_RELEASE"
atomic_symlink "$NEW_RELEASE" "$INSTALL_ROOT/current"
CURRENT_SWITCHED=1
install_cli_launchers || die "Не удалось установить CLI-команды в $(cli_bin_dir)."

if [[ $ENABLE_SYSTEMD == true ]]; then
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  SERVICE_STARTED=1
  systemctl start "$SERVICE_NAME"
  if ! wait_for_health; then
    journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
    die "Сервис не прошёл health checks после установки."
  fi
fi

commit_cli_transaction
ROLLBACK_HANDLER=""
log "Установка завершена: $NEW_RELEASE"
APP_VERSION=$(read_release_value "$NEW_RELEASE" APP_VERSION 2>/dev/null || printf unknown)
print_install_summary "$COMMIT" "$APP_VERSION"
(( SHOW_ADMIN_INSTRUCTIONS )) && print_admin_instructions
printf '\nИнструкция для первого superuser: docs/INSTALLATION.md\n' >&2
