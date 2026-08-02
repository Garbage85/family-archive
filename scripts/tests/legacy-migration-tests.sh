#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
MIGRATOR="$PROJECT_ROOT/scripts/migrate-legacy-server.sh"
SUITE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/family-archive-legacy-tests.XXXXXX")
PASSED=0
FAILED=0
case_root=""

cleanup() {
  if [[ -n $SUITE_ROOT && $SUITE_ROOT == "${TMPDIR:-/tmp}"/family-archive-legacy-tests.* && -d $SUITE_ROOT ]]; then
    chmod -R u+w "$SUITE_ROOT" 2>/dev/null || true
    rm -rf -- "$SUITE_ROOT"
  fi
}
trap cleanup EXIT

pass() {
  PASSED=$((PASSED + 1))
  printf 'ok legacy %s - %s\n' "$PASSED" "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf 'not ok legacy %s - %s\n' "$((PASSED + FAILED))" "$1" >&2
}

assert_success() {
  local name=$1
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

assert_failure() {
  local name=$1
  shift
  if "$@"; then fail "$name"; else pass "$name"; fi
}

assert_file_value() {
  local expected=$1 file=$2 name=$3 actual=""
  [[ -f $file ]] && actual=$(cat "$file")
  if [[ $actual == "$expected" ]]; then pass "$name"; else fail "$name (получено '$actual')"; fi
}

make_mocks() {
  local root=$1 bin pocketbase_file
  bin="$root/mock-bin"
  pocketbase_file="$root/zip-content/pocketbase"
  mkdir -p "$bin" "$root/zip-content"
  # shellcheck disable=SC2016 # Переменные раскрываются при запуске mock.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -eu' \
    'command=${1:-}' \
    'printf "%s\n" "$*" >> "$MOCK_SYSTEMCTL_LOG"' \
    'case "$command" in' \
    '  cat) cat "$MOCK_UNIT_PATH" ;;' \
    '  show) if [[ $* == *"ExecStart"* ]]; then sed -n "s/^ExecStart=//p" "$MOCK_UNIT_PATH"; elif [[ $* == *"DropInPaths"* ]]; then :; else printf "%s\n" "$MOCK_UNIT_PATH"; fi ;;' \
    '  is-active) [[ $(cat "$MOCK_SERVICE_STATE") == active ]] ;;' \
    '  is-enabled) [[ $(cat "$MOCK_ENABLED_STATE") == enabled ]] ;;' \
    '  stop) printf inactive > "$MOCK_SERVICE_STATE" ;;' \
    '  start) printf active > "$MOCK_SERVICE_STATE" ;;' \
    '  enable) printf enabled > "$MOCK_ENABLED_STATE" ;;' \
    '  disable) printf disabled > "$MOCK_ENABLED_STATE" ;;' \
    '  daemon-reload) : ;;' \
    '  *) : ;;' \
    'esac' > "$bin/systemctl"
  # shellcheck disable=SC2016 # Переменные раскрываются при запуске mock.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -eu' \
    'output=' \
    'write_status=0' \
    'last=' \
    'while (($#)); do' \
    '  case "$1" in' \
    '    --output) output=$2; shift 2 ;;' \
    '    --write-out) write_status=1; shift 2 ;;' \
    '    *) last=$1; shift ;;' \
    '  esac' \
    'done' \
    'if [[ -n $output && $output != /dev/null ]]; then cp "$MOCK_POCKETBASE_ZIP" "$output"; exit 0; fi' \
    'if [[ ${FAMILY_ARCHIVE_MIGRATION_TEST_FAIL:-} == health ]] && grep -q "/current/pocketbase" "$MOCK_UNIT_PATH"; then' \
    '  if (( write_status )); then printf 503; fi' \
    '  exit 22' \
    'fi' \
    'if (( write_status )); then printf 200; fi' \
    'exit 0' > "$bin/curl"
  # shellcheck disable=SC2016 # Переменные раскрываются при запуске mock.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [[ $(cat "$MOCK_SERVICE_STATE") == active ]]; then printf "LISTEN 0 128 127.0.0.1:8090 0.0.0.0:*\n"; fi' \
    > "$bin/ss"
  # shellcheck disable=SC2016 # Переменные раскрываются при запуске mock.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -eu' \
    'if [[ ${1:-} == ci ]]; then exit 0; fi' \
    'if [[ ${1:-} == run && ${2:-} == build && ${FAMILY_ARCHIVE_MIGRATION_TEST_FAIL:-} == build ]]; then exit 73; fi' \
    'if [[ ${1:-} == run && ${2:-} == build ]]; then mkdir -p ../pb_public; printf built > ../pb_public/index.html; fi' \
    'exit 0' > "$bin/npm"
  # shellcheck disable=SC2016 # Переменные раскрываются при запуске mock.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -eu' \
    'while (($#)); do [[ $1 == -- ]] && { shift; break; }; shift; done' \
    'exec "$@"' > "$bin/runuser"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$bin/journalctl"
  # shellcheck disable=SC2016 # Аргументы fake PocketBase разбираются только при его запуске.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -eu' \
    'data_dir=' \
    'for argument in "$@"; do [[ $argument == --dir=* ]] && data_dir=${argument#*=}; done' \
    'if [[ ${1:-} == migrate ]]; then' \
    '  printf changed > "$data_dir/data.db"' \
    '  [[ ${FAMILY_ARCHIVE_MIGRATION_TEST_FAIL:-} == migration ]] && exit 77' \
    '  printf migrated > "$data_dir/data.db"' \
    'fi' \
    'exit 0' > "$pocketbase_file"
  chmod 0755 "$bin/"* "$pocketbase_file"
  (cd "$root" && zip -qj "$root/pocketbase.zip" "$pocketbase_file")
}

make_legacy() {
  local root=$1 legacy unit_dir state=${2:-active}
  legacy="$root/legacy"
  unit_dir="$root/systemd"
  mkdir -p "$legacy/"{pb_data,pb_migrations,pb_public,frontend,scripts,systemd} \
    "$unit_dir" "$root/config" "$root/lock"
  printf legacy-binary > "$legacy/pocketbase"
  chmod 0755 "$legacy/pocketbase"
  printf before > "$legacy/pb_data/data.db"
  printf 'migration\n' > "$legacy/pb_migrations/1.js"
  printf 'legacy-public\n' > "$legacy/pb_public/index.html"
  printf '%s\n' '[Unit]' '[Service]' \
    "ExecStart=$legacy/pocketbase serve --http=0.0.0.0:8090" \
    > "$unit_dir/family-tree.service"
  printf '%s' "$state" > "$root/service-state"
  printf enabled > "$root/enabled-state"
  : > "$root/systemctl.log"
}

run_migration() {
  local root=$1 failpoint=${2:-} extra=${3:-} install_root=${4:-} checksum
  [[ -n $install_root ]] || install_root="$root/legacy"
  checksum=$(sha256sum "$root/pocketbase.zip" | awk '{print $1}')
  env PATH="$root/mock-bin:$PATH" \
    TMPDIR="$root" \
    FAMILY_ARCHIVE_MIGRATION_TEST_MODE=1 \
    FAMILY_ARCHIVE_MIGRATION_TEST_FAIL="$failpoint" \
    FAMILY_ARCHIVE_MIGRATION_TEST_POCKETBASE_SHA256="$checksum" \
    FAMILY_ARCHIVE_SYSTEMD_DIR="$root/systemd" \
    FAMILY_ARCHIVE_CONFIG_DIR="$root/config" \
    FAMILY_ARCHIVE_LOCK_DIR="$root/lock" \
    MOCK_UNIT_PATH="$root/systemd/family-tree.service" \
    MOCK_SERVICE_STATE="$root/service-state" \
    MOCK_ENABLED_STATE="$root/enabled-state" \
    MOCK_SYSTEMCTL_LOG="$root/systemctl.log" \
    MOCK_POCKETBASE_ZIP="$root/pocketbase.zip" \
    "$MIGRATOR" --legacy-root "$root/legacy" --install-root "$install_root" \
      --repo "$PROJECT_ROOT" --branch main --yes ${extra:+"$extra"}
}

new_case() {
  local destination_var=$1 name=$2 root
  root="$SUITE_ROOT/$name"
  mkdir -p "$root"
  make_mocks "$root"
  make_legacy "$root"
  printf -v "$destination_var" '%s' "$root"
}

new_case case_root dry-run
before=$(find "$case_root/legacy" "$case_root/systemd" -printf '%P %y %s\n' | sort)
assert_success 'dry-run проходит только read-only проверки' \
  run_migration "$case_root" '' --dry-run
after=$(find "$case_root/legacy" "$case_root/systemd" -printf '%P %y %s\n' | sort)
if [[ $before == "$after" ]]; then
  pass 'dry-run не изменяет legacy и unit'
else
  fail 'dry-run изменил legacy или unit'
fi
assert_file_value active "$case_root/service-state" 'dry-run не останавливает active unit'

new_case case_root custom-port
sed -i 's/:8090$/:8097/' "$case_root/systemd/family-tree.service"
output=$(run_migration "$case_root" '' --dry-run)
if [[ $output == *'Legacy port будет сохранён: 8097'* ]]; then
  pass 'migration сохраняет legacy-порт из systemd unit'
else
  fail 'migration не показала сохранение legacy-порта 8097'
fi

new_case case_root missing-pb-data
mv "$case_root/legacy/pb_data" "$case_root/missing-pb-data"
assert_failure 'отсутствующий pb_data отклоняется до изменений' run_migration "$case_root"
assert_file_value active "$case_root/service-state" 'ошибка структуры не останавливает unit'

new_case case_root backup-error
assert_failure 'ошибка offline backup прерывает миграцию' run_migration "$case_root" preflight-backup
assert_file_value active "$case_root/service-state" 'после ошибки backup legacy unit снова active'
assert_file_value before "$case_root/legacy/pb_data/data.db" 'ошибка backup не меняет базу'

new_case case_root build-error
assert_failure 'ошибка frontend build прерывает подготовку release' run_migration "$case_root" build
assert_file_value active "$case_root/service-state" 'после ошибки build legacy unit работает'
assert_success 'ошибка build не переименовывает legacy-root' test -x "$case_root/legacy/pocketbase"

new_case case_root migration-error
assert_failure 'ошибка PocketBase migrate запускает rollback' run_migration "$case_root" migration
assert_file_value before "$case_root/legacy/pb_data/data.db" 'rollback миграции восстанавливает final backup'
assert_file_value active "$case_root/service-state" 'rollback миграции запускает старую версию'
assert_success 'rollback миграции возвращает старый unit' \
  grep -Fqx "ExecStart=$case_root/legacy/pocketbase serve --http=0.0.0.0:8090" \
    "$case_root/systemd/family-tree.service"

new_case case_root health-error
assert_failure 'ошибка health check запускает rollback' run_migration "$case_root" health
assert_file_value before "$case_root/legacy/pb_data/data.db" 'rollback health failure отменяет применённую миграцию'
assert_file_value active "$case_root/service-state" 'health rollback возвращает active legacy unit'
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'неудачная новая установка сохранена для расследования' \
  bash -c 'compgen -G "$1/legacy.failed-migration-*" >/dev/null' _ "$case_root"

new_case case_root active-unit
assert_success 'активный legacy unit мигрирует с двумя offline окнами' run_migration "$case_root"
order=$(awk '$1 == "stop" || $1 == "start" {printf "%s ", $1}' "$case_root/systemctl.log")
if [[ $order == 'stop start stop start ' ]]; then
  pass 'active unit перезапускается после preflight и после cutover'
else
  fail "неверный порядок active unit: $order"
fi
assert_file_value migrated "$case_root/legacy/shared/pb_data/data.db" 'успешная миграция применяет схему к shared data'
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'успешная миграция создаёт current внутри releases' \
  bash -c '[[ -L $1/current && $(readlink -f "$1/current") == "$1/releases/"* ]]' _ "$case_root/legacy"
archive=$(find "$case_root" -maxdepth 1 -type d -name 'legacy.legacy-*' -print -quit)
assert_success 'старая плоская установка сохранена под timestamp-именем' test -x "$archive/pocketbase"
assert_success 'по умолчанию legacy pb_data указывает на единственную рабочую базу' test -L "$archive/pb_data"
backup_count=$(find "$case_root/legacy/backups" -maxdepth 1 -type f -name '*.tar.gz' | wc -l)
if [[ $backup_count == 2 ]]; then
  pass 'после успеха сохранены оба проверенных backup'
else
  fail 'не сохранены два backup'
fi

new_case case_root keep-legacy
assert_success '--keep-legacy сохраняет отдельный forensic snapshot' run_migration "$case_root" '' --keep-legacy
archive=$(find "$case_root" -maxdepth 1 -type d -name 'legacy.legacy-*' -print -quit)
assert_success 'keep-legacy оставляет физический pb_data' test -d "$archive/pb_data"
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'сохранённый keep-legacy pb_data read-only' \
  bash -c '[[ -z $(find "$1" -perm /222 -print -quit) ]]' _ "$archive/pb_data"
assert_file_value migrated "$case_root/legacy/shared/pb_data/data.db" 'keep-legacy рабочая база независима от read-only snapshot'

new_case case_root separate-root
assert_success 'разные legacy-root и install-root поддерживаются' \
  run_migration "$case_root" '' '' "$case_root/install"
assert_file_value migrated "$case_root/install/shared/pb_data/data.db" 'отдельный install-root получает рабочую базу'
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'отдельный legacy-root переименован и сохранён' \
  bash -c 'compgen -G "$1/legacy.legacy-*" >/dev/null && [[ ! -e $1/legacy ]]' _ "$case_root"

printf 'Legacy migration tests: %s passed, %s failed.\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
