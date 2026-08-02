#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Безопасная миграция плоской legacy-установки Family Archive в releases/shared.

Использование:
  sudo ./scripts/migrate-legacy-server.sh [опции]

Опции:
  --dry-run             Проверить окружение и показать план без изменений
  --legacy-root PATH    Корень legacy-установки (по умолчанию /opt/family-tree)
  --install-root PATH   Корень новой установки (по умолчанию /opt/family-tree)
  --repo URL            Git-репозиторий release
  --branch NAME         Ветка Git (по умолчанию main)
  --keep-legacy         Оставить отдельный read-only снимок legacy pb_data
  --yes                 Подтвердить реальную миграцию без интерактивного вопроса
  -h, --help            Показать справку

Без --keep-legacy данные перемещаются в shared/pb_data, а pb_data в сохранённом
legacy-каталоге становится симлинком на единственную рабочую копию.
EOF
}

set_default_config
[[ -n ${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_URL:-} ]] &&
  REPOSITORY_URL=$FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_URL
[[ -n ${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_BRANCH:-} ]] &&
  DEFAULT_BRANCH=$FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_BRANCH
LEGACY_ROOT=/opt/family-tree
DRY_RUN=0
KEEP_LEGACY=0
ASSUME_YES=0
TEST_MODE=${FAMILY_ARCHIVE_MIGRATION_TEST_MODE:-0}
TEST_FAIL=${FAMILY_ARCHIVE_MIGRATION_TEST_FAIL:-}
SYSTEMD_DIR=${FAMILY_ARCHIVE_SYSTEMD_DIR:-/etc/systemd/system}
CONFIG_DIR=${FAMILY_ARCHIVE_CONFIG_DIR:-/etc/family-tree}
LOCK_DIR=${FAMILY_ARCHIVE_LOCK_DIR:-/run/lock}
case "$TEST_MODE" in
  0)
    SYSTEMD_DIR=/etc/systemd/system
    CONFIG_DIR=/etc/family-tree
    LOCK_DIR=/run/lock
    ;;
  1) ;;
  *) die "FAMILY_ARCHIVE_MIGRATION_TEST_MODE допускает только 0 или 1." ;;
esac

WORK_DIR=""
BACKUP_DIR=""
INITIAL_BACKUP=""
FINAL_BACKUP=""
LEGACY_ARCHIVE=""
FAILED_INSTALL=""
NEW_RELEASE=""
RELEASE_STAGING=""
UNIT_PATH=""
ORIGINAL_UNIT_COPY=""
RELEASE_ID=""
COMMIT=""
STAGE=arguments
INITIAL_SERVICE_ACTIVE=0
INITIAL_SERVICE_ENABLED=0
FINAL_PHASE_STARTED=0
LEGACY_MOVED=0
CONFIG_CREATED=0
CONFIG_DIR_CREATED=0
UNIT_REPLACED=0
ENABLE_STATE_CHANGED=0

exit_if_help_requested usage "$@"
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --legacy-root) [[ $# -ge 2 ]] || die "Для --legacy-root требуется путь."; LEGACY_ROOT=$2; shift 2 ;;
    --legacy-root=*) LEGACY_ROOT=${1#*=}; shift ;;
    --install-root) [[ $# -ge 2 ]] || die "Для --install-root требуется путь."; INSTALL_ROOT=$2; shift 2 ;;
    --install-root=*) INSTALL_ROOT=${1#*=}; shift ;;
    --repo) [[ $# -ge 2 ]] || die "Для --repo требуется URL."; REPOSITORY_URL=$2; shift 2 ;;
    --repo=*) REPOSITORY_URL=${1#*=}; shift ;;
    --branch) [[ $# -ge 2 ]] || die "Для --branch требуется имя."; DEFAULT_BRANCH=$2; shift 2 ;;
    --branch=*) DEFAULT_BRANCH=${1#*=}; shift ;;
    --keep-legacy) KEEP_LEGACY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестная опция: $1" ;;
  esac
done

if (( TEST_MODE )); then
  SERVICE_USER=$(id -un)
  SERVICE_GROUP=$(id -gn)
  HEALTH_RETRIES=1
  HEALTH_DELAY_SECONDS=1
  if [[ -n ${FAMILY_ARCHIVE_MIGRATION_TEST_POCKETBASE_SHA256:-} ]]; then
    # shellcheck disable=SC2034 # Значения читаются косвенно pocketbase_checksum.
    POCKETBASE_SHA256_LINUX_AMD64=$FAMILY_ARCHIVE_MIGRATION_TEST_POCKETBASE_SHA256
    # shellcheck disable=SC2034 # Значения читаются косвенно pocketbase_checksum.
    POCKETBASE_SHA256_LINUX_ARM64=$FAMILY_ARCHIVE_MIGRATION_TEST_POCKETBASE_SHA256
    # shellcheck disable=SC2034 # Значения читаются косвенно pocketbase_checksum.
    POCKETBASE_SHA256_LINUX_ARMV7=$FAMILY_ARCHIVE_MIGRATION_TEST_POCKETBASE_SHA256
  fi
fi

validate_migration_path() {
  local name=$1 path=$2 component partial=""
  [[ $path =~ ^/[A-Za-z0-9._/-]+$ && $path != / && $path != */ && $path != *//* ]] ||
    die "$name должен быть абсолютным нормализованным путём без пробелов и завершающего /."
  path_entry_is_safe "${path#/}" || die "$name содержит переход за пределы каталога."
  [[ ! $path =~ (^|/)\.(/|$) ]] || die "$name содержит компонент '.'."
  IFS='/' read -r -a components <<< "${path#/}"
  for component in "${components[@]}"; do
    partial="$partial/$component"
    [[ ! -L $partial ]] || die "$name проходит через симлинк: $partial"
  done
  [[ $(realpath -m -- "$path") == "$path" ]] || die "$name не является нормализованным путём: $path"
}

path_is_below() {
  local path=$1 parent=$2
  [[ $path == "$parent"/* ]]
}

validate_test_sandbox() {
  local sandbox
  (( TEST_MODE )) || return 0
  sandbox="$(realpath -m -- "${TMPDIR:-/tmp}")"
  path_is_below "$LEGACY_ROOT" "$sandbox" || die "Test mode разрешён только внутри TMPDIR: $LEGACY_ROOT"
  path_is_below "$INSTALL_ROOT" "$sandbox" || die "Test mode разрешён только внутри TMPDIR: $INSTALL_ROOT"
  path_is_below "$SYSTEMD_DIR" "$sandbox" || die "Test systemd dir должен находиться внутри TMPDIR."
  path_is_below "$CONFIG_DIR" "$sandbox" || die "Test config dir должен находиться внутри TMPDIR."
  path_is_below "$LOCK_DIR" "$sandbox" || die "Test lock dir должен находиться внутри TMPDIR."
}

migration_failpoint() {
  local point=$1
  if (( TEST_MODE )) && [[ $TEST_FAIL == "$point" ]]; then
    die "Тестовая ошибка этапа: $point"
  fi
}

legacy_health_ok() {
  systemctl is-active --quiet "$SERVICE_NAME" &&
    port_is_listening &&
    [[ $(http_status_code /) == 200 ]] &&
    api_health_ok
}

wait_for_legacy_health() {
  local attempt
  for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
    legacy_health_ok && return 0
    sleep "$HEALTH_DELAY_SECONDS"
  done
  return 1
}

check_migration_free_space() {
  local parent=$1 data_kb legacy_kb available_kb required_kb multiplier=3
  data_kb=$(du -sk -- "$LEGACY_ROOT/pb_data" | awk '{print $1}')
  legacy_kb=$(du -sk -- "$LEGACY_ROOT" | awk '{print $1}')
  (( KEEP_LEGACY )) && multiplier=4
  required_kb=$((data_kb * multiplier + legacy_kb + MIN_FREE_MB * 1024))
  available_kb=$(df -Pk -- "$parent" | awk 'NR == 2 {print $4}')
  (( available_kb >= required_kb )) ||
    die "Недостаточно места для двух backup, release и cutover: нужно ${required_kb} KiB, доступно ${available_kb} KiB."
}

validate_legacy_layout() {
  local required entry expected_exec count fragment unit_text effective_exec dropins endpoint prefix
  local -a exec_lines=()
  [[ -d $LEGACY_ROOT && ! -L $LEGACY_ROOT ]] || die "Legacy-root не является обычным каталогом: $LEGACY_ROOT"
  [[ -f $LEGACY_ROOT/pocketbase && -x $LEGACY_ROOT/pocketbase && ! -L $LEGACY_ROOT/pocketbase ]] ||
    die "Не найден обычный исполняемый legacy pocketbase: $LEGACY_ROOT/pocketbase"
  for required in pb_data pb_migrations pb_public frontend scripts systemd; do
    entry="$LEGACY_ROOT/$required"
    [[ -d $entry && ! -L $entry ]] || die "Отсутствует обязательный legacy-каталог: $entry"
  done
  if find "$LEGACY_ROOT/pb_data" -type l -print -quit | grep -q .; then
    die "Legacy pb_data содержит симлинк; миграция остановлена."
  fi
  [[ -f $UNIT_PATH && ! -L $UNIT_PATH ]] || die "Legacy unit должен быть обычным файлом: $UNIT_PATH"
  mapfile -t exec_lines < <(grep '^ExecStart=' "$UNIT_PATH" || true)
  (( ${#exec_lines[@]} == 1 )) || die "Legacy unit должен содержать единственный ExecStart."
  expected_exec=${exec_lines[0]}
  prefix="ExecStart=$LEGACY_ROOT/pocketbase serve --http="
  [[ $expected_exec == "$prefix"* ]] || die "Legacy ExecStart использует неожиданный бинарный файл или формат."
  endpoint=${expected_exec#"$prefix"}
  [[ -n $endpoint && $endpoint != *[[:space:]]* ]] || die "Legacy --http должен содержать только адрес и порт."
  if [[ $endpoint =~ ^\[([^]]+)\]:([0-9]+)$ ]]; then
    LISTEN_HOST=${BASH_REMATCH[1]}
    PORT=${BASH_REMATCH[2]}
  elif [[ $endpoint =~ ^([^:]+):([0-9]+)$ ]]; then
    LISTEN_HOST=${BASH_REMATCH[1]}
    PORT=${BASH_REMATCH[2]}
  else
    die "Не удалось разобрать legacy --http: $endpoint"
  fi
  validate_listen_host "$LISTEN_HOST"
  validate_port "$PORT"
  unit_text=$(systemctl cat "$SERVICE_NAME") || die "systemd не видит unit $SERVICE_NAME."
  count=$(grep -Fxc -- "$expected_exec" <<< "$unit_text" || true)
  (( count == 1 )) || die "Загруженный systemd unit не совпадает с проверенным legacy unit."
  if grep '^ExecStart=' <<< "$unit_text" | grep -Fvx -- "$expected_exec" | grep -q .; then
    die "Загруженный systemd unit содержит дополнительный или переопределённый ExecStart."
  fi
  fragment=$(systemctl show "$SERVICE_NAME" --property=FragmentPath --value 2>/dev/null || true)
  [[ -z $fragment || $fragment == "$UNIT_PATH" ]] ||
    die "systemd использует другой unit: ${fragment:-неизвестно}"
  effective_exec=$(systemctl show "$SERVICE_NAME" --property=ExecStart --value 2>/dev/null || true)
  [[ -z $effective_exec || $effective_exec == *"$LEGACY_ROOT/pocketbase"* &&
    $effective_exec == *"--http=$endpoint"* ]] ||
    die "Эффективный ExecStart systemd не соответствует legacy-команде."
  dropins=$(systemctl show "$SERVICE_NAME" --property=DropInPaths --value 2>/dev/null || true)
  [[ -z $dropins ]] || die "Для legacy unit настроены drop-in файлы; сначала разберите их вручную: $dropins"
}

create_legacy_backup() {
  local label=$1 archive snapshot staging checksum metadata_name
  archive="$BACKUP_DIR/family-archive-legacy-${TIMESTAMP}-${label}.tar.gz"
  snapshot="$WORK_DIR/snapshot-$label"
  staging="$WORK_DIR/.backup-$label"
  [[ ! -e $archive && ! -e $archive.sha256 ]] || die "Backup уже существует: $archive"
  mkdir -p "$snapshot/pb_data" "$snapshot/pb_migrations" "$snapshot/systemd" "$staging"
  rsync -a --delete "$LEGACY_ROOT/pb_data/" "$snapshot/pb_data/"
  rsync -a --delete "$LEGACY_ROOT/pb_migrations/" "$snapshot/pb_migrations/"
  install -m 0644 "$UNIT_PATH" "$snapshot/systemd/${SERVICE_NAME}.service"
  metadata_name="$snapshot/metadata.json"
  jq -n \
    --arg created_at "$(date --iso-8601=seconds)" \
    --arg phase "$label" \
    --arg legacy_root "$LEGACY_ROOT" \
    --arg install_root "$INSTALL_ROOT" \
    --arg unit "$UNIT_PATH" \
    --arg repo "$REPOSITORY_URL" \
    --arg branch "$DEFAULT_BRANCH" \
    '{format_version:1,created_at:$created_at,phase:$phase,legacy_root:$legacy_root,install_root:$install_root,unit:$unit,repository:$repo,branch:$branch}' \
    > "$metadata_name"
  migration_failpoint "$label-backup"
  tar -C "$snapshot" -czf "$staging/$(basename "$archive")" .
  chmod 0600 "$staging/$(basename "$archive")"
  validate_tar_archive "$staging/$(basename "$archive")"
  tar -tzf "$staging/$(basename "$archive")" | grep -Eq '^\./metadata\.json$|^metadata\.json$' ||
    die "Backup не содержит metadata.json."
  tar -tzf "$staging/$(basename "$archive")" | grep -Eq "^\./systemd/${SERVICE_NAME}\.service$|^systemd/${SERVICE_NAME}\.service$" ||
    die "Backup не содержит legacy unit."
  checksum=$(sha256sum "$staging/$(basename "$archive")" | awk '{print $1}')
  printf '%s  %s\n' "$checksum" "$(basename "$archive")" > "$staging/$(basename "$archive").sha256"
  chmod 0600 "$staging/$(basename "$archive").sha256"
  mv "$staging/$(basename "$archive").sha256" "$archive.sha256"
  mv "$staging/$(basename "$archive")" "$archive"
  verify_backup_checksum "$archive"
  printf '%s\n' "$archive"
}

stop_legacy_service() {
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    systemctl stop "$SERVICE_NAME"
  elif (( INITIAL_SERVICE_ACTIVE )); then
    die "Legacy-сервис перестал быть active до cutover."
  elif port_is_listening; then
    die "Unit не active, но TCP $(listen_port) занят; возможен незарегистрированный процесс PocketBase."
  fi
}

revalidate_under_lock() {
  validate_legacy_layout
  [[ ! -e $LEGACY_ARCHIVE && ! -L $LEGACY_ARCHIVE ]] ||
    die "Путь сохранения legacy появился во время подготовки: $LEGACY_ARCHIVE"
  if (( ! SAME_ROOT )); then
    [[ ! -e $INSTALL_ROOT && ! -L $INSTALL_ROOT ]] ||
      die "Install-root появился во время подготовки: $INSTALL_ROOT"
  fi
  [[ ! -e $CONFIG_DIR/deployment.env && ! -L $CONFIG_DIR/deployment.env ]] ||
    die "Deployment-конфиг появился во время подготовки: $CONFIG_DIR/deployment.env"
  if (( INITIAL_SERVICE_ACTIVE )); then
    systemctl is-active --quiet "$SERVICE_NAME" ||
      die "Legacy-сервис перестал быть active во время подготовки."
  elif systemctl is-active --quiet "$SERVICE_NAME" || port_is_listening; then
    die "Изначально остановленный legacy-сервис или его порт стали active во время подготовки."
  fi
}

start_legacy_service_after_preflight() {
  (( INITIAL_SERVICE_ACTIVE )) || return 0
  systemctl start "$SERVICE_NAME"
  wait_for_legacy_health || die "Legacy-сервис не восстановился после preflight backup."
}

prepare_release_offline() {
  local mirror="$WORK_DIR/repository.git" checkout="$WORK_DIR/source/repository"
  STAGE='release-preparation'
  mkdir -p "$WORK_DIR/source"
  git clone --mirror "$REPOSITORY_URL" "$mirror"
  COMMIT=$(git --git-dir="$mirror" rev-parse "refs/heads/${DEFAULT_BRANCH}^{commit}")
  [[ $COMMIT =~ ^[0-9a-f]{40}$ ]] || die "Не удалось разрешить ветку $DEFAULT_BRANCH."
  git clone --no-checkout --shared "$mirror" "$checkout"
  git -C "$checkout" checkout --detach "$COMMIT"
  run_frontend_checks "$checkout"
  validate_migrations "$checkout/pb_migrations"
  RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-${COMMIT:0:12}"
  RELEASE_STAGING="$WORK_DIR/release-$RELEASE_ID"
  assemble_release "$checkout" "$RELEASE_STAGING" "$COMMIT" "$DEFAULT_BRANCH" "$DEFAULT_BRANCH"
  release_is_valid "$RELEASE_STAGING" || die "Подготовленный release не прошёл проверку целостности."
}

ensure_service_account() {
  getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --gid "$SERVICE_GROUP" --home-dir "$INSTALL_ROOT/shared" \
      --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  elif (( ! TEST_MODE )) && [[ $(getent passwd "$SERVICE_USER" | cut -d: -f7) != /usr/sbin/nologin ]]; then
    die "Существующий пользователь $SERVICE_USER имеет login shell; исправьте его до миграции."
  fi
}

choose_unused_path() {
  local destination_var=$1 base=$2 candidate suffix=0
  candidate=$base
  while [[ -e $candidate || -L $candidate ]]; do
    ((suffix += 1))
    candidate="$base-$suffix"
  done
  printf -v "$destination_var" '%s' "$candidate"
}

restore_legacy_data_from_final_backup() {
  local extract="$WORK_DIR/rollback-extract" displaced=""
  [[ -f $FINAL_BACKUP ]] || return 1
  mkdir -p "$extract"
  tar -xzf "$FINAL_BACKUP" -C "$extract" || return 1
  [[ -d $extract/pb_data ]] || return 1
  if [[ -e $LEGACY_ROOT/pb_data || -L $LEGACY_ROOT/pb_data ]]; then
    if [[ -n $FAILED_INSTALL && -d $FAILED_INSTALL ]]; then
      choose_unused_path displaced "$FAILED_INSTALL/legacy-pb-data-after-failure"
    else
      choose_unused_path displaced "${LEGACY_ROOT}.pb-data-after-failure"
    fi
    mv "$LEGACY_ROOT/pb_data" "$displaced" || return 1
  fi
  mv "$extract/pb_data" "$LEGACY_ROOT/pb_data" || return 1
  return 0
}

forget_work_dir() {
  local path
  local -a remaining=()
  # shellcheck disable=SC2031 # Здесь намеренно фильтруется общий массив cleanup текущего shell.
  for path in "${TEMP_DIRS[@]:-}"; do
    [[ $path == "$WORK_DIR" ]] || remaining+=("$path")
  done
  TEMP_DIRS=("${remaining[@]}")
}

migration_failure_rollback() {
  local exit_code=${1:-1} rollback_ok=1 service_result=not-required data_result=not-required
  local unit_result=not-required legacy_result=unchanged
  set +e
  ROLLBACK_HANDLER=""
  warn "Миграция прервана на этапе '$STAGE' (код $exit_code); начинаю rollback."
  if (( FINAL_PHASE_STARTED )); then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || rollback_ok=0
  fi
  if (( LEGACY_MOVED )); then
    if [[ -e $INSTALL_ROOT || -L $INSTALL_ROOT ]]; then
      choose_unused_path FAILED_INSTALL "${INSTALL_ROOT}.failed-migration-${TIMESTAMP}"
      mv "$INSTALL_ROOT" "$FAILED_INSTALL" || rollback_ok=0
    fi
    if [[ ! -e $LEGACY_ROOT && ! -L $LEGACY_ROOT ]]; then
      if mv "$LEGACY_ARCHIVE" "$LEGACY_ROOT"; then
        legacy_result=restored
      else
        legacy_result=FAILED
        rollback_ok=0
      fi
    else
      legacy_result=FAILED
      rollback_ok=0
    fi
    if [[ -d $LEGACY_ROOT && -f $FINAL_BACKUP ]]; then
      if restore_legacy_data_from_final_backup; then
        data_result=restored-from-final-backup
      else
        data_result=FAILED
        rollback_ok=0
      fi
    fi
  fi
  if (( UNIT_REPLACED )) && [[ -f $ORIGINAL_UNIT_COPY ]]; then
    if install -m 0644 "$ORIGINAL_UNIT_COPY" "$UNIT_PATH"; then
      unit_result=restored
    else
      unit_result=FAILED
      rollback_ok=0
    fi
  fi
  if (( ENABLE_STATE_CHANGED )); then
    if (( INITIAL_SERVICE_ENABLED )); then
      systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || rollback_ok=0
    else
      systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || rollback_ok=0
    fi
  fi
  if (( CONFIG_CREATED )) && [[ -f $CONFIG_DIR/deployment.env ]]; then
    rm -f -- "$CONFIG_DIR/deployment.env" || rollback_ok=0
  fi
  if (( CONFIG_DIR_CREATED )); then
    rmdir "$CONFIG_DIR" 2>/dev/null || true
  fi
  systemctl daemon-reload >/dev/null 2>&1 || rollback_ok=0
  if (( INITIAL_SERVICE_ACTIVE )); then
    if systemctl start "$SERVICE_NAME" >/dev/null 2>&1 && wait_for_legacy_health; then
      service_result=legacy-active-and-healthy
    else
      service_result=FAILED
      rollback_ok=0
    fi
  else
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    service_result=legacy-left-inactive
  fi
  forget_work_dir
  printf '\nROLLBACK REPORT\n' >&2
  printf '  stage: %s\n  legacy-root: %s (%s)\n  unit: %s (%s)\n  data: %s\n  service: %s\n' \
    "$STAGE" "$LEGACY_ROOT" "$legacy_result" "$UNIT_PATH" "$unit_result" \
    "$data_result" "$service_result" >&2
  [[ -n $FAILED_INSTALL ]] && printf '  failed-install: %s\n' "$FAILED_INSTALL" >&2
  printf '  recovery-artifacts: %s\n  result: %s\n' "$WORK_DIR" \
    "$([[ $rollback_ok == 1 ]] && printf SUCCESS || printf INCOMPLETE)" >&2
}

require_commands realpath
validate_migration_path LEGACY_ROOT "$LEGACY_ROOT"
validate_migration_path INSTALL_ROOT "$INSTALL_ROOT"
validate_migration_path SYSTEMD_DIR "$SYSTEMD_DIR"
validate_migration_path CONFIG_DIR "$CONFIG_DIR"
validate_migration_path LOCK_DIR "$LOCK_DIR"
validate_test_sandbox
if (( ! TEST_MODE )); then
  require_root
  [[ $REPOSITORY_URL =~ ^https://[A-Za-z0-9._~:/@%+=,-]+$ ]] ||
    die "--repo должен быть безопасным HTTPS URL."
else
  [[ $REPOSITORY_URL != -* && $REPOSITORY_URL != *[[:space:]]* ]] || die "Некорректный test repo."
fi
[[ -n $DEFAULT_BRANCH && $DEFAULT_BRANCH != -* && $DEFAULT_BRANCH != *[[:space:]]* &&
  $DEFAULT_BRANCH != *..* && $DEFAULT_BRANCH != *@\{* ]] || die "Некорректный --branch."
if (( TEST_MODE )) && [[ $REPOSITORY_URL != https://* ]]; then
  TEST_REPOSITORY_URL=$REPOSITORY_URL
  REPOSITORY_URL=https://test.invalid/family-archive.git
  validate_config
  REPOSITORY_URL=$TEST_REPOSITORY_URL
else
  validate_config
fi

setup_traps
require_commands realpath systemctl grep find df du awk sed tar sha256sum flock rsync jq git curl unzip \
  node npm runuser install mv cp chmod chown getent id cut sleep ss mkdir basename dirname date \
  mktemp rmdir rm ln uname
pocketbase_arch_for "$(uname -m)" >/dev/null
UNIT_PATH="$SYSTEMD_DIR/${SERVICE_NAME}.service"
STAGE=preflight-validation
validate_legacy_layout

LEGACY_CANON=$(realpath -m -- "$LEGACY_ROOT")
INSTALL_CANON=$(realpath -m -- "$INSTALL_ROOT")
SAME_ROOT=0
[[ $LEGACY_CANON == "$INSTALL_CANON" ]] && SAME_ROOT=1
if (( ! SAME_ROOT )); then
  [[ $INSTALL_CANON != "$LEGACY_CANON"/* && $LEGACY_CANON != "$INSTALL_CANON"/* ]] ||
    die "Legacy-root и install-root не могут быть вложены друг в друга."
  [[ ! -e $INSTALL_ROOT && ! -L $INSTALL_ROOT ]] ||
    die "Install-root уже существует; мигратор не перемещает данные поверх путей: $INSTALL_ROOT"
fi
if [[ -e $CONFIG_DIR ]]; then
  [[ -d $CONFIG_DIR && ! -L $CONFIG_DIR ]] || die "Config dir должен быть обычным каталогом: $CONFIG_DIR"
  [[ ! -e $CONFIG_DIR/deployment.env && ! -L $CONFIG_DIR/deployment.env ]] ||
    die "Deployment-конфиг уже существует; отказ от перезаписи: $CONFIG_DIR/deployment.env"
fi
INSTALL_PARENT=$(dirname "$INSTALL_ROOT")
[[ -d $INSTALL_PARENT && ! -L $INSTALL_PARENT ]] || die "Родитель install-root недоступен: $INSTALL_PARENT"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
choose_unused_path LEGACY_ARCHIVE "${LEGACY_ROOT}.legacy-${TIMESTAMP}"
check_migration_free_space "$INSTALL_PARENT"
if systemctl is-active --quiet "$SERVICE_NAME"; then
  INITIAL_SERVICE_ACTIVE=1
fi
if systemctl is-enabled --quiet "$SERVICE_NAME"; then
  INITIAL_SERVICE_ENABLED=1
fi

if (( DRY_RUN )); then
  printf 'Dry-run: изменений не выполнено.\n'
  printf 'Legacy: %s\nInstall: %s\nRepository: %s\nBranch: %s\n' \
    "$LEGACY_ROOT" "$INSTALL_ROOT" "$REPOSITORY_URL" "$DEFAULT_BRANCH"
  printf 'Legacy port будет сохранён: %s\n' "$PORT"
  printf 'Unit: %s (%s)\nСохранённая установка: %s\n' "$UNIT_PATH" \
    "$([[ $INITIAL_SERVICE_ACTIVE == 1 ]] && printf active || printf inactive)" "$LEGACY_ARCHIVE"
  printf 'Cutover: flock -> stop -> final backup -> data -> migrations -> unit -> current -> health.\n'
  exit 0
fi

confirm_or_die "Начать реальную legacy-миграцию после успешных preflight-проверок?" "$ASSUME_YES"

require_commands groupadd useradd journalctl
WORK_DIR=$(mktemp -d "$INSTALL_PARENT/.family-archive-legacy-migration.XXXXXX")
TEMP_DIRS+=("$WORK_DIR")
BACKUP_DIR="$WORK_DIR/backups"
mkdir -p "$BACKUP_DIR"
chmod 0700 "$WORK_DIR" "$BACKUP_DIR"
ORIGINAL_UNIT_COPY="$WORK_DIR/original-${SERVICE_NAME}.service"
install -m 0644 "$UNIT_PATH" "$ORIGINAL_UNIT_COPY"
write_install_config "$WORK_DIR/deployment.env"
ROLLBACK_HANDLER=migration_failure_rollback

STAGE=preflight-offline-backup
stop_legacy_service
INITIAL_BACKUP=$(create_legacy_backup preflight)
start_legacy_service_after_preflight

prepare_release_offline
if (( INITIAL_SERVICE_ACTIVE )); then
  systemctl is-active --quiet "$SERVICE_NAME" || die "Legacy-сервис не active после подготовки release."
fi

STAGE=cutover-lock
mkdir -p "$LOCK_DIR"
exec 9>"$LOCK_DIR/family-archive-legacy-migration.lock"
flock -n 9 || die "Другая legacy-миграция уже выполняется."

STAGE=cutover-revalidation
revalidate_under_lock

FINAL_PHASE_STARTED=1
STAGE=final-offline-backup
stop_legacy_service
FINAL_BACKUP=$(create_legacy_backup final)

STAGE=legacy-relocation
ensure_service_account
if (( ! SAME_ROOT )); then
  [[ ! -e $INSTALL_ROOT && ! -L $INSTALL_ROOT ]] ||
    die "Install-root появился после preflight; отказ от перезаписи: $INSTALL_ROOT"
fi
[[ ! -e $LEGACY_ARCHIVE && ! -L $LEGACY_ARCHIVE ]] || die "Путь сохранения legacy уже существует: $LEGACY_ARCHIVE"
mv -T "$LEGACY_ROOT" "$LEGACY_ARCHIVE"
LEGACY_MOVED=1
mkdir "$INSTALL_ROOT"
mkdir "$INSTALL_ROOT/app" "$INSTALL_ROOT/backups" "$INSTALL_ROOT/releases" "$INSTALL_ROOT/shared"
chmod 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/app" "$INSTALL_ROOT/releases"
chmod 0700 "$INSTALL_ROOT/backups"
chmod 0750 "$INSTALL_ROOT/shared"
mv "$WORK_DIR/repository.git" "$INSTALL_ROOT/app/repository.git"
NEW_RELEASE="$INSTALL_ROOT/releases/$RELEASE_ID"
[[ ! -e $NEW_RELEASE && ! -L $NEW_RELEASE ]] || die "Release уже существует: $NEW_RELEASE"
mv "$RELEASE_STAGING" "$NEW_RELEASE"

STAGE=data-relocation
if (( KEEP_LEGACY )); then
  mkdir -p "$INSTALL_ROOT/shared/pb_data"
  rsync -a --delete "$LEGACY_ARCHIVE/pb_data/" "$INSTALL_ROOT/shared/pb_data/"
else
  mv "$LEGACY_ARCHIVE/pb_data" "$INSTALL_ROOT/shared/pb_data"
  ln -s "$INSTALL_ROOT/shared/pb_data" "$LEGACY_ARCHIVE/pb_data"
fi
chmod 0750 "$INSTALL_ROOT/shared/pb_data"
if (( TEST_MODE )); then
  chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_ROOT/shared"
else
  chown "root:$SERVICE_GROUP" "$INSTALL_ROOT/shared"
fi
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_ROOT/shared/pb_data"

if [[ ! -d $CONFIG_DIR ]]; then
  mkdir "$CONFIG_DIR"
  CONFIG_DIR_CREATED=1
fi
[[ ! -e $CONFIG_DIR/deployment.env && ! -L $CONFIG_DIR/deployment.env ]] ||
  die "Deployment-конфиг появился после preflight; отказ от перезаписи: $CONFIG_DIR/deployment.env"
if ! (umask 077; set -o noclobber; : > "$CONFIG_DIR/deployment.env"); then
  die "Не удалось эксклюзивно создать deployment-конфиг: $CONFIG_DIR/deployment.env"
fi
CONFIG_CREATED=1
install -m 0600 "$WORK_DIR/deployment.env" "$CONFIG_DIR/deployment.env"
install -m 0600 "$WORK_DIR/deployment.env" "$INSTALL_ROOT/shared/deployment.env"

STAGE=production-migrations
apply_migrations "$NEW_RELEASE"

STAGE=unit-and-current
UNIT_REPLACED=1
write_systemd_unit "$UNIT_PATH"
atomic_symlink "$NEW_RELEASE" "$INSTALL_ROOT/current"
systemctl daemon-reload
ENABLE_STATE_CHANGED=1
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

STAGE=health-check
if ! wait_for_health; then
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
  die "Новая установка не прошла systemd/TCP/HTTP/API health checks."
fi

STAGE=finalization
if (( KEEP_LEGACY )); then
  chmod -R a-w "$LEGACY_ARCHIVE/pb_data"
fi
for backup in "$INITIAL_BACKUP" "$FINAL_BACKUP"; do
  [[ ! -e $INSTALL_ROOT/backups/$(basename "$backup") ]] || die "Backup destination уже существует."
  cp -p "$backup" "$backup.sha256" "$INSTALL_ROOT/backups/"
  verify_backup_checksum "$INSTALL_ROOT/backups/$(basename "$backup")"
done
ROLLBACK_HANDLER=""
printf 'Legacy-миграция завершена.\nСтарый commit: legacy/неизвестен\nНовый commit: %s\nСтарый порт: %s\nНовый порт: %s\nLegacy сохранён: %s\n' \
  "$COMMIT" "$PORT" "$PORT" "$LEGACY_ARCHIVE"
printf 'Backups: %s, %s\nHealth: ok\nURL: %s/\n' \
  "$INSTALL_ROOT/backups/$(basename "$INITIAL_BACKUP")" \
  "$INSTALL_ROOT/backups/$(basename "$FINAL_BACKUP")" "$(local_base_url)"
