#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Rollback Family Archive.

Использование:
  sudo ./scripts/rollback-server.sh --previous [--yes]
  sudo ./scripts/rollback-server.sh --release ID_OR_COMMIT [--yes]
  sudo ./scripts/rollback-server.sh --backup FILE --restore-data [--release ID] [--yes]
  sudo ./scripts/rollback-server.sh --list

Опции:
  --previous          Переключиться на предыдущий release
  --release VALUE     Release ID, путь или уникальный префикс commit
  --backup FILE       Архив из backups или полный путь
  --restore-data      Явно разрешить замену shared/pb_data из --backup
  --list              Показать releases и backups
  --yes               Подтвердить предупреждение неинтерактивно
  --config FILE       Deployment-конфигурация
  -h, --help          Показать справку
EOF
}

SELECT_PREVIOUS=0
RELEASE_SELECTOR=""
BACKUP_SELECTOR=""
RESTORE_DATA=0
LIST_ONLY=0
ASSUME_YES=0
ORIGINAL_RELEASE=""
TARGET_RELEASE=""
EMERGENCY_BACKUP=""
DATA_CHANGED=0
CURRENT_SWITCHED=0
ROLLBACK_PHASE_STARTED=0

list_available() {
  local path marker commit deployed
  printf 'Releases:\n'
  while IFS= read -r path; do
    [[ -n $path ]] || continue
    release_is_valid "$path" || continue
    marker=' '
    [[ $path == "$ORIGINAL_RELEASE" ]] && marker='*'
    commit="$(read_release_value "$path" COMMIT 2>/dev/null || printf unknown)"
    deployed="$(read_release_value "$path" DEPLOYED_AT 2>/dev/null || printf unknown)"
    printf ' %s %-36s commit=%s deployed=%s\n' "$marker" "$(basename "$path")" "$commit" "$deployed"
  done < <(find "$INSTALL_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)
  printf '\nBackups:\n'
  find "$INSTALL_ROOT/backups" -maxdepth 1 -type f -name 'family-archive-*.tar.gz' \
    -printf '  %f\n' 2>/dev/null | sort -r || true
}

resolve_release() {
  local selector=$1 path candidate commit matches=0 result=""
  if [[ $selector == /* ]]; then
    path="$(readlink -f "$selector")"
    [[ $path == "$INSTALL_ROOT/releases/"* && -d $path ]] || die "Release вне $INSTALL_ROOT/releases: $selector"
    release_is_valid "$path" || die "Release '$selector' неполон или повреждён."
    printf '%s\n' "$path"
    return
  fi
  [[ $selector != */* && $selector != . && $selector != .. ]] ||
    die "Относительный selector release должен быть ID или префиксом commit без '/'."
  if [[ -d $INSTALL_ROOT/releases/$selector ]]; then
    release_is_valid "$INSTALL_ROOT/releases/$selector" || die "Release '$selector' неполон или повреждён."
    printf '%s\n' "$INSTALL_ROOT/releases/$selector"
    return
  fi
  while IFS= read -r candidate; do
    release_is_valid "$candidate" || continue
    commit="$(read_release_value "$candidate" COMMIT 2>/dev/null || true)"
    if [[ $commit == "$selector"* ]]; then
      ((matches += 1))
      result=$candidate
    fi
  done < <(find "$INSTALL_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -print)
  (( matches == 1 )) || die "Release '$selector' не найден или префикс commit неоднозначен."
  printf '%s\n' "$result"
}

resolve_previous_release() {
  local candidate
  while IFS= read -r candidate; do
    [[ $candidate == "$ORIGINAL_RELEASE" ]] && continue
    release_is_valid "$candidate" || continue
    printf '%s\n' "$candidate"
    return
  done < <(find "$INSTALL_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  die "Предыдущий release не найден."
}

rollback_failure_recovery() {
  set +e
  warn "Rollback не завершён; возвращаю исходный release и данные."
  if (( ROLLBACK_PHASE_STARTED )); then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    if (( CURRENT_SWITCHED )) && [[ -d $ORIGINAL_RELEASE ]]; then
      atomic_symlink "$ORIGINAL_RELEASE" "$INSTALL_ROOT/current"
    fi
    if (( DATA_CHANGED )) && [[ -f $EMERGENCY_BACKUP ]]; then
      restore_data_from_backup_isolated \
        "$EMERGENCY_BACKUP" "failed-rollback-$(date +%Y%m%d-%H%M%S)" >/dev/null || true
    fi
    systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || true
    wait_for_health || warn "Исходное состояние не прошло health check; требуется ручная диагностика."
  fi
}

exit_if_help_requested usage "$@"
preparse_config "$@"
load_config

while (($#)); do
  case "$1" in
    --previous) SELECT_PREVIOUS=1; shift ;;
    --release) [[ $# -ge 2 ]] || die "Для --release требуется значение."; RELEASE_SELECTOR=$2; shift 2 ;;
    --release=*) RELEASE_SELECTOR=${1#*=}; shift ;;
    --backup) [[ $# -ge 2 ]] || die "Для --backup требуется путь."; BACKUP_SELECTOR=$2; shift 2 ;;
    --backup=*) BACKUP_SELECTOR=${1#*=}; shift ;;
    --restore-data) RESTORE_DATA=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --config) shift 2 ;;
    --config=*) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done

setup_traps
require_root
require_commands rsync jq systemctl tar sha256sum flock find sort cut sed head readlink journalctl \
  curl ss grep awk df sleep
[[ -L $INSTALL_ROOT/current ]] || die "Текущий release не найден."
check_free_space "$INSTALL_ROOT"
ORIGINAL_RELEASE="$(current_release)" || die "Текущий release неполон, повреждён или находится вне $INSTALL_ROOT/releases."

if (( LIST_ONLY )) || (( ! SELECT_PREVIOUS )) && [[ -z $RELEASE_SELECTOR && -z $BACKUP_SELECTOR ]]; then
  list_available
  ROLLBACK_HANDLER=""
  exit 0
fi
(( SELECT_PREVIOUS == 0 )) || [[ -z $RELEASE_SELECTOR ]] || die "Используйте только одну из опций --previous и --release."
[[ -z $BACKUP_SELECTOR || $RESTORE_DATA -eq 1 ]] || die "Для восстановления backup обязательна явная опция --restore-data."
(( RESTORE_DATA == 0 )) || [[ -n $BACKUP_SELECTOR ]] || die "Для --restore-data укажите --backup FILE."

if (( SELECT_PREVIOUS )); then
  TARGET_RELEASE="$(resolve_previous_release)"
elif [[ -n $RELEASE_SELECTOR ]]; then
  TARGET_RELEASE="$(resolve_release "$RELEASE_SELECTOR")"
else
  TARGET_RELEASE=$ORIGINAL_RELEASE
fi

if [[ -n $BACKUP_SELECTOR ]]; then
  if [[ $BACKUP_SELECTOR == /* ]]; then
    RESTORE_ARCHIVE=$BACKUP_SELECTOR
  else
    [[ $BACKUP_SELECTOR != */* && $BACKUP_SELECTOR != . && $BACKUP_SELECTOR != .. ]] ||
      die "Относительный путь backup должен быть только именем файла; для другого пути используйте абсолютный путь."
    RESTORE_ARCHIVE="$INSTALL_ROOT/backups/$BACKUP_SELECTOR"
  fi
  validate_tar_archive "$RESTORE_ARCHIVE"
  if [[ -f $RESTORE_ARCHIVE.sha256 ]]; then
    verify_backup_checksum "$RESTORE_ARCHIVE"
  else
    warn "Для backup нет соседнего .sha256; внутренняя структура проверена, но происхождение не подтверждено."
  fi
fi

if (( ! RESTORE_DATA )); then
  warn "Rollback release выполняется без восстановления данных. Старый код может быть несовместим с уже применёнными миграциями."
fi
confirm_or_die "Выполнить rollback к $(basename "$TARGET_RELEASE")?" "$ASSUME_YES"

acquire_update_lock
[[ $(current_release) == "$ORIGINAL_RELEASE" ]] || die "Текущий release изменился во время подтверждения; повторите rollback."
log "Создаю аварийный backup перед rollback."
EMERGENCY_BACKUP="$("$SCRIPT_DIR"/backup-server.sh --quiet --no-prune --config "$CONFIG_FILE")"
[[ -f $EMERGENCY_BACKUP ]] || die "Аварийный backup не создан."

ROLLBACK_HANDLER=rollback_failure_recovery
ROLLBACK_PHASE_STARTED=1
systemctl stop "$SERVICE_NAME"
if (( RESTORE_DATA )); then
  restore_data_from_backup "$RESTORE_ARCHIVE"
  PRESERVED_DATA=$RESTORED_PREVIOUS_DATA
  DATA_CHANGED=1
  warn "Предыдущий pb_data сохранён: $PRESERVED_DATA"
fi
if [[ $TARGET_RELEASE != "$ORIGINAL_RELEASE" ]]; then
  atomic_symlink "$TARGET_RELEASE" "$INSTALL_ROOT/current"
  CURRENT_SWITCHED=1
fi
systemctl start "$SERVICE_NAME"

if ! wait_for_health; then
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
  die "Состояние после rollback не прошло health checks."
fi

ROLLBACK_HANDLER=""
printf 'Rollback завершён.\nRelease: %s\nCommit: %s\nАварийный backup: %s\nURL: %s/\n' \
  "$TARGET_RELEASE" "$(read_release_value "$TARGET_RELEASE" COMMIT 2>/dev/null || printf unknown)" \
  "$EMERGENCY_BACKUP" "$(local_base_url)"
