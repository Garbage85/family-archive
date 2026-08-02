#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Создание согласованного backup Family Archive.

Использование:
  sudo ./scripts/backup-server.sh [опции]

Опции:
  --output PATH    Каталог или полный путь *.tar.gz
  --keep N         Сколько архивов сохранить в каталоге
  --no-prune       Не удалять старые архивы после этого backup
  --service-stopped Требовать уже остановленный сервис и не запускать его
  --quiet          Вывести только путь готового архива
  --config FILE    Deployment-конфигурация
  -h, --help       Показать справку

Сервис останавливается только на время копирования pb_data во временный каталог.
EOF
}

OUTPUT=""
KEEP=""
NO_PRUNE=0
SERVICE_STOPPED_EXTERNALLY=0
SERVICE_WAS_ACTIVE=0
SERVICE_STOPPED=0

backup_failure_cleanup() {
  set +e
  if (( SERVICE_WAS_ACTIVE && SERVICE_STOPPED )); then
    systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
}

exit_if_help_requested usage "$@"
preparse_config "$@"
load_config

while (($#)); do
  case "$1" in
    --output) [[ $# -ge 2 ]] || die "Для --output требуется путь."; OUTPUT=$2; shift 2 ;;
    --output=*) OUTPUT=${1#*=}; shift ;;
    --keep) [[ $# -ge 2 ]] || die "Для --keep требуется число."; KEEP=$2; shift 2 ;;
    --keep=*) KEEP=${1#*=}; shift ;;
    --no-prune) NO_PRUNE=1; shift ;;
    --service-stopped) SERVICE_STOPPED_EXTERNALLY=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --config) shift 2 ;;
    --config=*) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done

[[ -n $KEEP ]] && KEEP_BACKUPS=$KEEP
validate_positive_integer KEEP_BACKUPS "$KEEP_BACKUPS"
[[ -z $OUTPUT || $OUTPUT == /* ]] || die "--output должен быть абсолютным путём."

setup_traps
ROLLBACK_HANDLER=backup_failure_cleanup
require_root
require_commands rsync jq systemctl tar sha256sum flock find sort cut sed head curl ss grep awk sleep
[[ -d $INSTALL_ROOT/shared/pb_data ]] || die "Не найден $INSTALL_ROOT/shared/pb_data."
acquire_update_lock

mkdir -p "$INSTALL_ROOT/backups" "$INSTALL_ROOT/shared"
chmod 0700 "$INSTALL_ROOT/backups"
exec 8>"$INSTALL_ROOT/shared/backup.lock"
flock -n 8 || die "Другой backup уже выполняется."

CURRENT_RELEASE="$(current_release 2>/dev/null || true)"
COMMIT="$(current_commit 2>/dev/null || printf unknown)"
SHORT_COMMIT=${COMMIT:0:12}
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="family-archive-${TIMESTAMP}-${SHORT_COMMIT}.tar.gz"

if [[ -z $OUTPUT ]]; then
  OUTPUT_DIR="$INSTALL_ROOT/backups"
  ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_NAME"
elif [[ $OUTPUT == *.tar.gz ]]; then
  ARCHIVE_PATH=$OUTPUT
  OUTPUT_DIR="$(dirname "$OUTPUT")"
else
  OUTPUT_DIR=$OUTPUT
  ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_NAME"
fi
mkdir -p "$OUTPUT_DIR"
[[ ! -e $ARCHIVE_PATH && ! -e $ARCHIVE_PATH.sha256 ]] || die "Файл backup уже существует: $ARCHIVE_PATH"

make_temp_dir SNAPSHOT_DIR 'family-archive-backup.XXXXXX'
mkdir -p "$SNAPSHOT_DIR/pb_data" "$SNAPSHOT_DIR/pb_migrations" \
  "$SNAPSHOT_DIR/systemd" "$SNAPSHOT_DIR/config"

if (( SERVICE_STOPPED_EXTERNALLY )); then
  systemctl is-active --quiet "$SERVICE_NAME" &&
    die "Для --service-stopped сервис $SERVICE_NAME должен быть остановлен."
  log "Создаю offline-снимок уже остановленного сервиса $SERVICE_NAME."
elif systemctl is-active --quiet "$SERVICE_NAME"; then
  SERVICE_WAS_ACTIVE=1
  log "Кратко останавливаю $SERVICE_NAME для согласованного снимка pb_data."
  SERVICE_STOPPED=1
  systemctl stop "$SERVICE_NAME"
fi
rsync -a --delete "$INSTALL_ROOT/shared/pb_data/" "$SNAPSHOT_DIR/pb_data/"
if (( SERVICE_WAS_ACTIVE )); then
  systemctl start "$SERVICE_NAME"
  SERVICE_STOPPED=0
  wait_for_health || die "Сервис не восстановился после создания снимка."
fi

if [[ -n $CURRENT_RELEASE && -d $CURRENT_RELEASE/pb_migrations ]]; then
  rsync -a --delete "$CURRENT_RELEASE/pb_migrations/" "$SNAPSHOT_DIR/pb_migrations/"
fi
[[ -f /etc/systemd/system/${SERVICE_NAME}.service ]] && \
  install -m 0644 "/etc/systemd/system/${SERVICE_NAME}.service" "$SNAPSHOT_DIR/systemd/${SERVICE_NAME}.service"
if [[ -f $CONFIG_FILE ]]; then
  install -m 0600 "$CONFIG_FILE" "$SNAPSHOT_DIR/config/deployment.env"
elif [[ -f $INSTALL_ROOT/shared/deployment.env ]]; then
  install -m 0600 "$INSTALL_ROOT/shared/deployment.env" "$SNAPSHOT_DIR/config/deployment.env"
fi

POCKETBASE_RELEASE_VERSION=""
SOURCE_REF=""
if [[ -n $CURRENT_RELEASE ]]; then
  POCKETBASE_RELEASE_VERSION="$(read_release_value "$CURRENT_RELEASE" POCKETBASE_VERSION 2>/dev/null || true)"
  SOURCE_REF="$(read_release_value "$CURRENT_RELEASE" SOURCE_REF 2>/dev/null || true)"
fi
jq -n \
  --arg created_at "$(date --iso-8601=seconds)" \
  --arg commit "$COMMIT" \
  --arg source_ref "$SOURCE_REF" \
  --arg pocketbase_version "${POCKETBASE_RELEASE_VERSION:-$POCKETBASE_VERSION}" \
  --arg release "$CURRENT_RELEASE" \
  '{format_version:1,created_at:$created_at,commit:$commit,source_ref:$source_ref,pocketbase_version:$pocketbase_version,release:$release}' \
  > "$SNAPSHOT_DIR/metadata.json"

make_temp_dir OUTPUT_STAGING "$OUTPUT_DIR/.family-archive-backup.XXXXXX"
PARTIAL_ARCHIVE="$OUTPUT_STAGING/$ARCHIVE_NAME"
PARTIAL_SHA="$OUTPUT_STAGING/$ARCHIVE_NAME.sha256"
tar -C "$SNAPSHOT_DIR" -czf "$PARTIAL_ARCHIVE" .
chmod 0600 "$PARTIAL_ARCHIVE"
validate_tar_archive "$PARTIAL_ARCHIVE"
printf '%s  %s\n' "$(sha256sum "$PARTIAL_ARCHIVE" | awk '{print $1}')" "$(basename "$ARCHIVE_PATH")" > "$PARTIAL_SHA"
chmod 0600 "$PARTIAL_SHA"
mv "$PARTIAL_SHA" "$ARCHIVE_PATH.sha256"
mv "$PARTIAL_ARCHIVE" "$ARCHIVE_PATH"

ROLLBACK_HANDLER=""
if (( ! NO_PRUNE )) && ! prune_backups "$OUTPUT_DIR" "$KEEP_BACKUPS"; then
  warn "Новый backup готов, но удалить часть старых архивов не удалось."
fi
if (( QUIET )); then
  printf '%s\n' "$ARCHIVE_PATH"
else
  printf 'Backup создан и проверен: %s\nSHA-256: %s\n' "$ARCHIVE_PATH" "$ARCHIVE_PATH.sha256"
  printf 'Рекомендация: регулярно копируйте архив и checksum на отдельный off-site носитель.\n'
fi
