#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Версия текущего release Family Archive без сетевых запросов и health check.

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
RELEASE_ID="$(basename "$CURRENT_RELEASE")"
COMMIT="$(read_release_value "$CURRENT_RELEASE" COMMIT 2>/dev/null || printf unknown)"
SOURCE_REF="$(read_release_value "$CURRENT_RELEASE" SOURCE_REF 2>/dev/null || printf unknown)"
DEPLOYED_AT="$(read_release_value "$CURRENT_RELEASE" DEPLOYED_AT 2>/dev/null || printf unknown)"
PB_VERSION="$(read_release_value "$CURRENT_RELEASE" POCKETBASE_VERSION 2>/dev/null || printf unknown)"
APP_VERSION="$(read_release_value "$CURRENT_RELEASE" APP_VERSION 2>/dev/null || printf unknown)"

if (( JSON_OUTPUT )); then
  require_commands jq
  jq -n \
    --arg release "$RELEASE_ID" \
    --arg app_version "$APP_VERSION" \
    --arg commit "$COMMIT" \
    --arg source_ref "$SOURCE_REF" \
    --arg deployed_at "$DEPLOYED_AT" \
    --arg pocketbase_version "$PB_VERSION" \
    '{app_version:$app_version,release:$release,commit:$commit,source_ref:$source_ref,deployed_at:$deployed_at,pocketbase_version:$pocketbase_version}'
else
  printf '%-20s %s\n' \
    'Family Archive:' "$APP_VERSION" \
    'Release:' "$RELEASE_ID" \
    'Commit:' "$COMMIT" \
    'Source ref:' "$SOURCE_REF" \
    'Deployed at:' "$DEPLOYED_AT" \
    'PocketBase:' "$PB_VERSION"
fi
