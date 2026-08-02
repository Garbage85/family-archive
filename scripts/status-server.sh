#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Статус Family Archive.

Использование:
  sudo ./scripts/status-server.sh [--json] [--no-logs] [--config FILE]

Опции:
  --json          Машиночитаемый JSON
  --no-logs       Не показывать последние строки журнала
  --config FILE   Deployment-конфигурация
  -h, --help      Показать справку
EOF
}

JSON_OUTPUT=0
NO_LOGS=0

exit_if_help_requested usage "$@"
preparse_config "$@"
load_config
while (($#)); do
  case "$1" in
    --json) JSON_OUTPUT=1; shift ;;
    --no-logs) NO_LOGS=1; shift ;;
    --config) shift 2 ;;
    --config=*) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done

setup_traps
require_root
require_commands git curl jq node systemctl tar df du find sort sed head journalctl ss grep awk

if [[ $ENABLE_SYSTEMD == false ]]; then
  SERVICE_STATE=disabled
elif systemctl is-active --quiet "$SERVICE_NAME"; then
  SERVICE_STATE=active
else
  SERVICE_STATE=inactive
fi
CURRENT_RELEASE="$(current_release 2>/dev/null || true)"
COMMIT="$(current_commit 2>/dev/null || printf unknown)"
SOURCE_REF=""
PB_VERSION="${POCKETBASE_VERSION:-unknown}"
if [[ -n $CURRENT_RELEASE ]]; then
  SOURCE_REF="$(read_release_value "$CURRENT_RELEASE" SOURCE_REF 2>/dev/null || true)"
  PB_VERSION="$(read_release_value "$CURRENT_RELEASE" POCKETBASE_VERSION 2>/dev/null || printf '%s' "$PB_VERSION")"
fi
NODE_VERSION="$(node --version 2>/dev/null || printf unavailable)"
HTTP_CODE="$(http_status_code /)"
if api_health_ok; then API_HEALTH=ok; else API_HEALTH=failed; fi
if port_is_listening; then PORT_STATE=listening; else PORT_STATE=closed; fi
PORT_PROCESS="$(port_listener_details)"
LOCAL_URL="$(local_base_url)"
PB_DATA_SIZE="$(du -sh "$INSTALL_ROOT/shared/pb_data" 2>/dev/null | awk '{print $1}' || printf unavailable)"
LAST_BACKUP="$(find "$INSTALL_ROOT/backups" -maxdepth 1 -type f -name 'family-archive-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)"
FREE_SPACE="$(df -hP "$INSTALL_ROOT" 2>/dev/null | awk 'NR == 2 {print $4}' || printf unavailable)"
REMOTE_COMMIT="$(git ls-remote "$REPOSITORY_URL" "refs/heads/$DEFAULT_BRANCH" 2>/dev/null | awk 'NR == 1 {print $1}' || true)"
if [[ -z $REMOTE_COMMIT ]]; then
  UPDATE_STATE=unknown
elif [[ $REMOTE_COMMIT == "$COMMIT" ]]; then
  UPDATE_STATE=up-to-date
else
  UPDATE_STATE=available
fi
if (( NO_LOGS )); then
  LOGS=""
else
  LOGS="$(journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>&1 || true)"
fi

if (( JSON_OUTPUT )); then
  jq -n \
    --arg service "$SERVICE_STATE" \
    --arg release "$CURRENT_RELEASE" \
    --arg commit "$COMMIT" \
    --arg source_ref "$SOURCE_REF" \
    --arg pocketbase_version "$PB_VERSION" \
    --arg node_version "$NODE_VERSION" \
    --arg port "$PORT_STATE" \
    --arg port_number "$PORT" \
    --arg port_process "$PORT_PROCESS" \
    --arg site_name "$SITE_NAME" \
    --arg listen_host "$LISTEN_HOST" \
    --arg timezone "$TIMEZONE" \
    --arg local_url "$LOCAL_URL" \
    --arg http_code "$HTTP_CODE" \
    --arg api_health "$API_HEALTH" \
    --arg pb_data_size "$PB_DATA_SIZE" \
    --arg last_backup "$LAST_BACKUP" \
    --arg free_space "$FREE_SPACE" \
    --arg update "$UPDATE_STATE" \
    --arg remote_commit "$REMOTE_COMMIT" \
    --arg logs "$LOGS" \
    '{site_name:$site_name,listen_host:$listen_host,port:($port_number|tonumber),timezone:$timezone,local_url:$local_url,port_state:$port,port_process:$port_process,service:$service,release:$release,commit:$commit,source_ref:$source_ref,pocketbase_version:$pocketbase_version,node_version:$node_version,http_code:$http_code,api_health:$api_health,pb_data_size:$pb_data_size,last_backup:$last_backup,free_space:$free_space,update:$update,remote_commit:$remote_commit,logs:$logs}'
else
  printf '%-24s %s\n' \
    'SITE_NAME:' "$SITE_NAME" \
    'LISTEN_HOST:' "$LISTEN_HOST" \
    'PORT:' "$PORT" \
    'TIMEZONE:' "$TIMEZONE" \
    'Локальный URL:' "$LOCAL_URL" \
    'systemd:' "$SERVICE_STATE" \
    'Текущий release:' "${CURRENT_RELEASE:-не найден}" \
    'Commit:' "$COMMIT" \
    'Ветка/tag/ref:' "${SOURCE_REF:-неизвестно}" \
    'PocketBase:' "$PB_VERSION" \
    'Node.js:' "$NODE_VERSION" \
    'Состояние порта:' "$PORT_STATE" \
    'Процесс порта:' "$PORT_PROCESS" \
    'HTTP /:' "${HTTP_CODE:-ошибка}" \
    'API health:' "$API_HEALTH" \
    'Размер pb_data:' "$PB_DATA_SIZE" \
    'Последний backup:' "${LAST_BACKUP:-нет}" \
    'Свободное место:' "$FREE_SPACE" \
    "Обновление origin/$DEFAULT_BRANCH:" "$UPDATE_STATE${REMOTE_COMMIT:+ ($REMOTE_COMMIT)}"
  if (( ! NO_LOGS )); then
    printf '\nПоследние 20 строк журнала:\n%s\n' "$LOGS"
  fi
fi

[[ ( $ENABLE_SYSTEMD == false || $SERVICE_STATE == active ) && $HTTP_CODE == 200 && $API_HEALTH == ok ]]
