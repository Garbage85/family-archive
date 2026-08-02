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
  --admin-instructions   Показать безопасную инструкцию создания первого superuser
  -h, --help             Показать справку

Скрипт предназначен для чистой установки и откажется перезаписывать существующий
INSTALL_ROOT. Пароли и токены не принимаются ни через аргументы, ни через env.
EOF
}

BRANCH=""
REPO=""
SHOW_ADMIN_INSTRUCTIONS=0
NEW_RELEASE=""
NEW_RELEASE_CREATED=0
UNIT_CREATED=0
CURRENT_SWITCHED=0
SERVICE_STARTED=0
INSTALL_LAYOUT_CREATED=0
SOURCE_DIR=""
RELEASE_STAGING=""

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
       ssh -L 8090:${LISTEN_ADDRESS} USER@SERVER
  2. Откройте http://127.0.0.1:8090/_/ и используйте одноразовую ссылку
     первоначальной настройки из журнала:
       sudo journalctl -u ${SERVICE_NAME} --no-pager | grep -i installer

Не передавайте пароль аргументом команде и не сохраняйте его в deployment.env.
EOF
}

exit_if_help_requested usage "$@"
preparse_config "$@"
load_config

while (($#)); do
  case "$1" in
    --branch) [[ $# -ge 2 ]] || die "Для --branch требуется значение."; BRANCH=$2; shift 2 ;;
    --branch=*) BRANCH=${1#*=}; shift ;;
    --repo) [[ $# -ge 2 ]] || die "Для --repo требуется значение."; REPO=$2; shift 2 ;;
    --repo=*) REPO=${1#*=}; shift ;;
    --config) shift 2 ;;
    --config=*) shift ;;
    --admin-instructions) SHOW_ADMIN_INSTRUCTIONS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done

[[ -n $BRANCH ]] && DEFAULT_BRANCH=$BRANCH
[[ -n $REPO ]] && REPOSITORY_URL=$REPO
validate_config

setup_traps
require_root
require_commands apt-get dpkg-query grep awk sed find cut sort head runuser sleep
pocketbase_arch_for "$(uname -m)" >/dev/null

if [[ -L $INSTALL_ROOT ]]; then
  die "$INSTALL_ROOT является симлинком; чистая установка остановлена."
fi
if [[ -e $INSTALL_ROOT ]]; then
  [[ -d $INSTALL_ROOT ]] || die "$INSTALL_ROOT существует и не является каталогом."
  if [[ -n $(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null) ]]; then
    die "$INSTALL_ROOT уже содержит файлы. Для legacy-установки сначала выполните ручную миграцию по docs/INSTALLATION.md."
  fi
fi
if systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  die "systemd unit '$SERVICE_NAME' уже существует; чистая установка остановлена."
fi

install_missing_system_packages
check_node_version
check_free_space "$(dirname "$INSTALL_ROOT")"

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
write_systemd_unit "/etc/systemd/system/${SERVICE_NAME}.service"
UNIT_CREATED=1

log "Применяю проверенные миграции к shared/pb_data."
apply_migrations "$NEW_RELEASE"
atomic_symlink "$NEW_RELEASE" "$INSTALL_ROOT/current"
CURRENT_SWITCHED=1
install_cli_launchers || die "Не удалось установить команды в /usr/local/bin."

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
SERVICE_STARTED=1
systemctl start "$SERVICE_NAME"
if ! wait_for_health; then
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
  die "Сервис не прошёл health checks после установки."
fi

ROLLBACK_HANDLER=""
log "Установка завершена: $NEW_RELEASE"
printf 'Commit: %s\nURL: %s/\n' "$COMMIT" "$(local_base_url)"
(( SHOW_ADMIN_INSTRUCTIONS )) && print_admin_instructions
printf '\nИнструкция для первого superuser: docs/INSTALLATION.md\n' >&2
