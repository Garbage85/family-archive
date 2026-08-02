#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Безопасное обновление Family Archive через новый release.

Использование:
  sudo ./scripts/update-server.sh [опции]

Опции:
  --branch NAME       Обновить ветку (по умолчанию main)
  --ref REF           Установить конкретный commit/tag/branch
  --dry-run           Только показать план и доступный commit
  --skip-backup       Не создавать backup (запрещено при новых миграциях)
  --keep-releases N   Сколько releases сохранять после успеха
  --change-port PORT  Сменить HTTP-порт с backup и rollback при ошибке
  --yes               Подтвердить неинтерактивный запуск (update не спрашивает)
  --config FILE       Deployment-конфигурация
  -h, --help          Показать справку
EOF
}

BRANCH=${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_BRANCH:-}
REQUESTED_REF=""
DRY_RUN=0
SKIP_BACKUP=0
KEEP=""
OLD_RELEASE=""
OLD_COMMIT=""
NEW_RELEASE=""
NEW_RELEASE_CREATED=0
BACKUP_PATH=""
MIGRATIONS_CHANGED=0
MIGRATION_ATTEMPTED=0
CURRENT_SWITCHED=0
PRODUCTION_PHASE_STARTED=0
SOURCE_DIR=""
RELEASE_STAGING=""
CHANGE_PORT=""
OLD_PORT=""
PORT_CHANGE_BACKUP=""
PORT_CHANGE_HEALTH="не выполнялся"
CONFIG_REFRESHED=0
CONFIG_RECOVERY_DIR=""

cutover_refresh_deployment() {
  local unit_path="/etc/systemd/system/${SERVICE_NAME}.service"
  make_temp_dir CONFIG_RECOVERY_DIR 'family-archive-update-config.XXXXXX'
  install -m 0600 "$CONFIG_FILE" "$CONFIG_RECOVERY_DIR/deployment.env"
  install -m 0600 "$INSTALL_ROOT/shared/deployment.env" "$CONFIG_RECOVERY_DIR/shared-deployment.env"
  install -m 0644 "$unit_path" "$CONFIG_RECOVERY_DIR/service.unit"
  CONFIG_REFRESHED=1
  write_install_config "$CONFIG_FILE"
  install -m 0600 "$CONFIG_FILE" "$INSTALL_ROOT/shared/deployment.env"
  write_systemd_unit "$unit_path"
  systemctl daemon-reload
}

perform_port_change() {
  local recovery_dir=$1 unit_path="/etc/systemd/system/${SERVICE_NAME}.service"
  [[ -n $CHANGE_PORT ]] || return 0
  validate_port "$CHANGE_PORT"
  [[ $CHANGE_PORT != "$PORT" ]] || die "Новый порт совпадает с текущим: $PORT"
  require_available_port "$CHANGE_PORT"
  if [[ -n $BACKUP_PATH && -f $BACKUP_PATH ]]; then
    PORT_CHANGE_BACKUP=$BACKUP_PATH
  else
    PORT_CHANGE_BACKUP="$("$SCRIPT_DIR"/backup-server.sh --quiet --keep "$KEEP_BACKUPS" --config "$CONFIG_FILE")"
  fi
  [[ -f $PORT_CHANGE_BACKUP ]] || die "Backup перед сменой порта не создан."
  if change_port_transaction "$CHANGE_PORT" "$CONFIG_FILE" \
    "$INSTALL_ROOT/shared/deployment.env" "$unit_path" "$recovery_dir"; then
    PORT_CHANGE_HEALTH=ok
    return 0
  fi
  PORT_CHANGE_HEALTH='failed-rolled-back'
  die "Смена порта отменена и откачена."
}

cutover_stop_service() {
  log "Останавливаю сервис для финального backup, миграции и переключения."
  systemctl is-active --quiet "$SERVICE_NAME" ||
    die "Сервис $SERVICE_NAME перестал быть active во время подготовки release."
  PRODUCTION_PHASE_STARTED=1
  systemctl stop "$SERVICE_NAME"
}

cutover_create_backup() {
  if (( SKIP_BACKUP )); then
    BACKUP_PATH="пропущен оператором"
    warn "Backup пропущен по явной опции --skip-backup."
    return
  fi
  log "Создаю консистентный backup остановленного production."
  BACKUP_PATH="$("$SCRIPT_DIR"/backup-server.sh --service-stopped --quiet --keep "$KEEP_BACKUPS" --config "$CONFIG_FILE")"
  [[ -f $BACKUP_PATH ]] || die "Offline backup не был создан."
}

cutover_apply_migrations() {
  MIGRATION_ATTEMPTED=1
  apply_migrations "$NEW_RELEASE"
}

cutover_switch_current() {
  atomic_symlink "$NEW_RELEASE" "$INSTALL_ROOT/current"
  CURRENT_SWITCHED=1
}

cutover_start_service() {
  systemctl start "$SERVICE_NAME"
}

cutover_health_check() {
  if ! wait_for_health; then
    journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
    die "Новый release не прошёл health checks."
  fi
}

update_failure_rollback() {
  set +e
  warn "Обновление не завершено; возвращаю предыдущее состояние."
  restore_cli_launchers || warn "Не удалось полностью восстановить прежние CLI launchers."
  if (( PRODUCTION_PHASE_STARTED )); then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    if (( CONFIG_REFRESHED )) && [[ -d $CONFIG_RECOVERY_DIR ]]; then
      install -m 0600 "$CONFIG_RECOVERY_DIR/deployment.env" "$CONFIG_FILE" || true
      install -m 0600 "$CONFIG_RECOVERY_DIR/shared-deployment.env" "$INSTALL_ROOT/shared/deployment.env" || true
      install -m 0644 "$CONFIG_RECOVERY_DIR/service.unit" "/etc/systemd/system/${SERVICE_NAME}.service" || true
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    if (( CURRENT_SWITCHED )) && [[ -n $OLD_RELEASE && -d $OLD_RELEASE ]]; then
      atomic_symlink "$OLD_RELEASE" "$INSTALL_ROOT/current"
    fi
    if (( MIGRATION_ATTEMPTED && MIGRATIONS_CHANGED )) && [[ -n $BACKUP_PATH && -f $BACKUP_PATH ]]; then
      local preserved
      if preserved="$(restore_data_from_backup_isolated \
        "$BACKUP_PATH" "failed-update-$(date +%Y%m%d-%H%M%S)")"; then
        [[ -n $preserved ]] && warn "Данные неудачного обновления сохранены: $preserved"
      fi
    fi
    systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || true
    if ! wait_for_health; then
      warn "Предыдущая версия также не прошла health check. Проверьте journalctl -u $SERVICE_NAME."
    fi
  fi
  if (( NEW_RELEASE_CREATED )) && [[ -n $NEW_RELEASE && -d $NEW_RELEASE && $NEW_RELEASE == "$INSTALL_ROOT/releases/"* ]]; then
    if [[ -L $INSTALL_ROOT/current && $(readlink -f "$INSTALL_ROOT/current" 2>/dev/null || true) == "$NEW_RELEASE" ]]; then
      warn "Новый release остаётся целью current; не удаляю его после неудачного rollback: $NEW_RELEASE"
    else
      rm -rf -- "$NEW_RELEASE"
    fi
  fi
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
    --ref) [[ $# -ge 2 ]] || die "Для --ref требуется значение."; REQUESTED_REF=$2; shift 2 ;;
    --ref=*) REQUESTED_REF=${1#*=}; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --keep-releases) [[ $# -ge 2 ]] || die "Для --keep-releases требуется число."; KEEP=$2; shift 2 ;;
    --keep-releases=*) KEEP=${1#*=}; shift ;;
    --change-port) [[ $# -ge 2 ]] || die "Для --change-port требуется порт."; CHANGE_PORT=$2; shift 2 ;;
    --change-port=*) CHANGE_PORT=${1#*=}; shift ;;
    --port|--port=*) die "Для существующей установки используйте --change-port PORT." ;;
    --yes) shift ;;
    --config) shift 2 ;;
    --config=*) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done

[[ -n $BRANCH ]] && DEFAULT_BRANCH=$BRANCH
[[ -n ${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_URL:-} ]] &&
  REPOSITORY_URL=$FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_URL
[[ -n $KEEP ]] && KEEP_RELEASES=$KEEP
[[ -z $BRANCH || -z $REQUESTED_REF ]] || die "--branch и --ref нельзя использовать одновременно."
validate_config
OLD_PORT=$PORT
[[ -z $CHANGE_PORT ]] || validate_port "$CHANGE_PORT"
validate_positive_integer KEEP_RELEASES "$KEEP_RELEASES"

setup_traps
require_root
require_commands git curl unzip rsync jq node npm systemctl tar sha256sum flock ss \
  runuser find sort cut awk sed grep diff journalctl sleep readlink
pocketbase_arch_for "$(uname -m)" >/dev/null

[[ -L $INSTALL_ROOT/current ]] || die "Установка release-based не найдена: $INSTALL_ROOT/current."
[[ -d $INSTALL_ROOT/shared/pb_data ]] || die "Не найден shared/pb_data."
(( DRY_RUN )) || acquire_update_lock
systemctl is-active --quiet "$SERVICE_NAME" || die "Сервис $SERVICE_NAME не active; сначала выясните причину через status-server.sh."
check_free_space "$INSTALL_ROOT"

OLD_RELEASE="$(current_release)" || die "Текущий release неполон, повреждён или находится вне $INSTALL_ROOT/releases."
OLD_COMMIT="$(current_commit)"
TARGET_COMMIT="$(resolve_remote_commit "$REQUESTED_REF" "$DEFAULT_BRANCH")"
TARGET_LABEL=${REQUESTED_REF:-$DEFAULT_BRANCH}

if (( DRY_RUN )); then
  printf 'Dry-run: изменений не выполнено.\nТекущий commit: %s\nЦелевой ref: %s\nЦелевой commit: %s\n' \
    "$OLD_COMMIT" "$TARGET_LABEL" "$TARGET_COMMIT"
  [[ $OLD_COMMIT == "$TARGET_COMMIT" ]] && printf 'Обновление не требуется.\n'
  if [[ -n $CHANGE_PORT ]]; then
    require_available_port "$CHANGE_PORT"
    printf 'Старый порт: %s\nНовый порт: %s\n' "$OLD_PORT" "$CHANGE_PORT"
  else
    printf 'Порт будет сохранён: %s\n' "$OLD_PORT"
  fi
  ROLLBACK_HANDLER=""
  exit 0
fi

if [[ $OLD_COMMIT == "$TARGET_COMMIT" ]]; then
  ROLLBACK_HANDLER=update_failure_rollback
  install_cli_launchers || die "Не удалось установить или восстановить CLI-команды в $(cli_bin_dir)."
  if [[ -n $CHANGE_PORT ]]; then
    make_temp_dir PORT_CHANGE_TMP 'family-archive-port-change.XXXXXX'
    perform_port_change "$PORT_CHANGE_TMP/recovery"
    printf 'Обновление конфигурации завершено.\nСтарый commit: %s\nНовый commit: %s\nСтарый порт: %s\nНовый порт: %s\nBackup: %s\nHealth: %s\n' \
      "$OLD_COMMIT" "$OLD_COMMIT" "$OLD_PORT" "$PORT" "$PORT_CHANGE_BACKUP" "$PORT_CHANGE_HEALTH"
  else
    if health_check_once; then NOOP_HEALTH=ok; else NOOP_HEALTH=failed; fi
    printf 'Обновление не требуется.\nСтарый commit: %s\nНовый commit: %s\nСтарый порт: %s\nНовый порт: %s\nBackup: не создавался\nHealth: %s\n' \
      "$OLD_COMMIT" "$OLD_COMMIT" "$OLD_PORT" "$PORT" "$NOOP_HEALTH"
  fi
  commit_cli_transaction
  log "Уже установлен commit $OLD_COMMIT; обновление не требуется."
  ROLLBACK_HANDLER=""
  exit 0
fi

START_EPOCH=$(date +%s)
ROLLBACK_HANDLER=update_failure_rollback
prepare_repository_cache
CACHED_COMMIT="$(resolve_cached_commit "$REQUESTED_REF" "$DEFAULT_BRANCH")"
[[ $CACHED_COMMIT == "$TARGET_COMMIT" ]] || die "Remote ref изменился во время подготовки; повторите обновление."

make_temp_dir SOURCE_DIR 'family-archive-update-source.XXXXXX'
checkout_cached_source "$TARGET_COMMIT" "$SOURCE_DIR/repository"
log "Проверяю frontend для commit $TARGET_COMMIT, пока текущий сервис работает."
run_frontend_checks "$SOURCE_DIR/repository"
validate_migrations "$SOURCE_DIR/repository/pb_migrations"

RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-${TARGET_COMMIT:0:12}"
make_temp_dir RELEASE_STAGING "$INSTALL_ROOT/releases/.staging.XXXXXX"
assemble_release "$SOURCE_DIR/repository" "$RELEASE_STAGING" "$TARGET_COMMIT" \
  "$TARGET_LABEL" "$DEFAULT_BRANCH"
NEW_RELEASE="$INSTALL_ROOT/releases/$RELEASE_ID"
[[ ! -e $NEW_RELEASE ]] || die "Release уже существует: $NEW_RELEASE"
mv "$RELEASE_STAGING" "$NEW_RELEASE"
NEW_RELEASE_CREATED=1

if migrations_differ "$OLD_RELEASE" "$NEW_RELEASE"; then
  MIGRATIONS_CHANGED=1
fi
if (( SKIP_BACKUP && MIGRATIONS_CHANGED )); then
  die "--skip-backup запрещён: новый release содержит отличающиеся миграции."
fi
run_update_cutover_steps \
  cutover_stop_service \
  cutover_create_backup \
  cutover_apply_migrations \
  cutover_switch_current \
  cutover_refresh_deployment \
  cutover_start_service \
  cutover_health_check

install_cli_launchers || die "Не удалось установить или восстановить CLI-команды в $(cli_bin_dir)."
if [[ -n $CHANGE_PORT ]]; then
  make_temp_dir PORT_CHANGE_TMP 'family-archive-port-change.XXXXXX'
  perform_port_change "$PORT_CHANGE_TMP/recovery"
fi
commit_cli_transaction
ROLLBACK_HANDLER=""
if ! prune_releases "$KEEP_RELEASES"; then
  warn "Новый release работает, но удалить часть старых releases не удалось."
fi
END_EPOCH=$(date +%s)
printf 'Обновление завершено.\nСтарый commit: %s\nНовый commit: %s\nСтарый порт: %s\nНовый порт: %s\nBackup: %s\nBackup смены порта: %s\nHealth: %s\nВремя: %s секунд\nURL: %s/\n' \
  "$OLD_COMMIT" "$TARGET_COMMIT" "$OLD_PORT" "$PORT" "$BACKUP_PATH" "${PORT_CHANGE_BACKUP:-не требовался}" \
  "$([[ -n $CHANGE_PORT ]] && printf '%s' "$PORT_CHANGE_HEALTH" || printf ok)" "$((END_EPOCH - START_EPOCH))" "$(local_base_url)"
