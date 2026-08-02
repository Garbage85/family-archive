#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Версия текущего release и фактическая локальная deployment-конфигурация.

Использование:
  sudo ./scripts/version-server.sh [--json] [--config FILE]

Опции:
  --json          Машиночитаемый JSON
  --config FILE   Deployment-конфигурация
  -h, --help      Показать справку
EOF
}

JSON_OUTPUT=0

exit_if_help_requested usage "$@"
preparse_config "$@"
load_config
while (($#)); do
  case "$1" in
    --json) JSON_OUTPUT=1; shift ;;
    --config) shift 2 ;;
    --config=*) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done

setup_traps
require_root
CURRENT_RELEASE="$(current_release)" || die "Текущий release не найден или повреждён."
require_commands curl ss systemctl
RELEASE_ID="$(basename "$CURRENT_RELEASE")"
COMMIT="$(read_release_value "$CURRENT_RELEASE" COMMIT 2>/dev/null || printf unknown)"
SOURCE_REF="$(read_release_value "$CURRENT_RELEASE" SOURCE_REF 2>/dev/null || printf unknown)"
DEPLOYED_AT="$(read_release_value "$CURRENT_RELEASE" DEPLOYED_AT 2>/dev/null || printf unknown)"
PB_VERSION="$(read_release_value "$CURRENT_RELEASE" POCKETBASE_VERSION 2>/dev/null || printf unknown)"
APP_VERSION="$(read_release_value "$CURRENT_RELEASE" APP_VERSION 2>/dev/null || printf unknown)"
if port_is_listening; then PORT_STATE=listening; else PORT_STATE=closed; fi
PORT_PROCESS="$(port_listener_details)"
if [[ $ENABLE_SYSTEMD == false ]]; then
  SYSTEMD_STATE=disabled
else
  SYSTEMD_STATE=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || printf inactive)
fi
if api_health_ok; then HTTP_HEALTH=ok; else HTTP_HEALTH=failed; fi

if (( JSON_OUTPUT )); then
  require_commands jq
  jq -n \
    --arg release "$RELEASE_ID" \
    --arg app_version "$APP_VERSION" \
    --arg commit "$COMMIT" \
    --arg source_ref "$SOURCE_REF" \
    --arg deployed_at "$DEPLOYED_AT" \
    --arg pocketbase_version "$PB_VERSION" \
    --arg site_name "$SITE_NAME" \
    --arg listen_host "$LISTEN_HOST" \
    --arg port "$PORT" \
    --arg timezone "$TIMEZONE" \
    --arg local_url "$(local_base_url)" \
    --arg port_state "$PORT_STATE" \
    --arg port_process "$PORT_PROCESS" \
    --arg systemd "$SYSTEMD_STATE" \
    --arg health "$HTTP_HEALTH" \
    '{site_name:$site_name,listen_host:$listen_host,port:($port|tonumber),timezone:$timezone,local_url:$local_url,port_state:$port_state,port_process:$port_process,systemd:$systemd,http_health:$health,app_version:$app_version,release:$release,commit:$commit,source_ref:$source_ref,deployed_at:$deployed_at,pocketbase_version:$pocketbase_version}'
else
  printf '%-20s %s\n' \
    'SITE_NAME:' "$SITE_NAME" \
    'LISTEN_HOST:' "$LISTEN_HOST" \
    'PORT:' "$PORT" \
    'TIMEZONE:' "$TIMEZONE" \
    'Локальный URL:' "$(local_base_url)" \
    'Состояние порта:' "$PORT_STATE" \
    'Процесс порта:' "$PORT_PROCESS" \
    'systemd:' "$SYSTEMD_STATE" \
    'HTTP health:' "$HTTP_HEALTH" \
    'Family Archive:' "$APP_VERSION" \
    'Release:' "$RELEASE_ID" \
    'Commit:' "$COMMIT" \
    'Source ref:' "$SOURCE_REF" \
    'Deployed at:' "$DEPLOYED_AT" \
    'PocketBase:' "$PB_VERSION"
fi
