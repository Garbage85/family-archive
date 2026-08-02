#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/family-archive-deployment-tests.XXXXXX")
printf 'INSTALL_ROOT=%s/default-install\n' "$TEST_ROOT" > "$TEST_ROOT/deployment.env"
chmod 0600 "$TEST_ROOT/deployment.env"
DEPLOYMENT_CONFIG="$TEST_ROOT/deployment.env"
export DEPLOYMENT_CONFIG
# shellcheck source=scripts/lib/common.sh
source "$TEST_DIR/../lib/common.sh"
load_config
setup_traps
# shellcheck disable=SC2031 # The shared cleanup array is intentionally extended here.
TEMP_DIRS+=("$TEST_ROOT")

PASSED=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  printf 'ok %s - %s\n' "$PASSED" "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf 'not ok %s - %s\n' "$((PASSED + FAILED))" "$1" >&2
}

assert_equal() {
  local expected=$1 actual=$2 name=$3
  if [[ $actual == "$expected" ]]; then pass "$name"; else fail "$name (ожидалось '$expected', получено '$actual')"; fi
}

assert_success() {
  local name=$1
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

assert_failure() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi
}

assert_equal linux_arm64 "$(pocketbase_arch_for aarch64)" 'aarch64 преобразуется в linux_arm64'
assert_equal linux_arm64 "$(pocketbase_arch_for arm64)" 'arm64 преобразуется в linux_arm64'
assert_equal linux_amd64 "$(pocketbase_arch_for x86_64)" 'x86_64 преобразуется в linux_amd64'
assert_equal linux_armv7 "$(pocketbase_arch_for armv7l)" 'armv7l преобразуется в linux_armv7'
assert_failure 'неподдерживаемая архитектура отклоняется' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; pocketbase_arch_for riscv64"

assert_success 'обычный относительный путь безопасен' path_entry_is_safe 'pb_data/data.db'
assert_failure 'абсолютный путь запрещён' path_entry_is_safe '/etc/passwd'
assert_failure 'переход ../ запрещён' path_entry_is_safe 'pb_data/../../etc/passwd'
assert_failure 'обратный слеш запрещён' path_entry_is_safe 'pb_data\evil'

assert_failure 'явно указанный отсутствующий config отклоняется' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; preparse_config --config '$TEST_ROOT/missing.env'; load_config"

mkdir -p "$TEST_ROOT/config-cases"
printf '%s\n' 'KEEP_BACKUPS=9' 'LISTEN_ADDRESS=127.0.0.1:9090' > "$TEST_ROOT/config-cases/valid.env"
chmod 0600 "$TEST_ROOT/config-cases/valid.env"
assert_success 'декларативный config из whitelist загружается без исполнения shell' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; preparse_config --config '$TEST_ROOT/config-cases/valid.env'; load_config; [[ \$KEEP_BACKUPS == 9 && \$LISTEN_ADDRESS == 127.0.0.1:9090 ]]"
assert_success 'deployment.env.example соответствует whitelist и типам значений' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; set_default_config; parse_deployment_config '$PROJECT_ROOT/config/deployment.env.example'; validate_config"

printf '%s\n' 'UNKNOWN_KEY=value' > "$TEST_ROOT/config-cases/unknown.env"
# shellcheck disable=SC2016 # Тестовые payload должны остаться буквальными.
printf '%s\n' 'INSTALL_ROOT=$(touch /tmp/family-archive-config-pwned)' > "$TEST_ROOT/config-cases/substitution.env"
# shellcheck disable=SC2016 # Тестовые payload должны остаться буквальными.
printf '%s\n' 'INSTALL_ROOT=`touch /tmp/family-archive-config-backtick`' > "$TEST_ROOT/config-cases/backtick.env"
printf '%s\n' 'export KEEP_BACKUPS=9' > "$TEST_ROOT/config-cases/export.env"
# shellcheck disable=SC2016 # Тестовые payload должны остаться буквальными.
printf '%s\n' 'KEEP_BACKUPS=$DANGEROUS_VALUE' > "$TEST_ROOT/config-cases/expansion.env"
printf '%s\n' 'KEEP_BACKUPS=9>redirected' > "$TEST_ROOT/config-cases/redirect.env"
printf '%s\n' 'evil() { touch /tmp/family-archive-config-function; }' > "$TEST_ROOT/config-cases/function.env"
printf '%s\n' 'APP_NAME=family-' 'archive' > "$TEST_ROOT/config-cases/multiline.env"
chmod 0600 "$TEST_ROOT/config-cases/"*.env
for config_case in unknown substitution backtick export expansion redirect function multiline; do
  assert_failure "malicious config отклоняется: $config_case" bash -c \
    "source '$TEST_DIR/../lib/common.sh'; preparse_config --config '$TEST_ROOT/config-cases/$config_case.env'; load_config"
done
assert_success 'command substitution из config не выполняется' test ! -e /tmp/family-archive-config-pwned
assert_success 'backticks и функция из config не выполняются' test ! -e /tmp/family-archive-config-backtick
assert_success 'функция из config не создаёт побочных файлов' test ! -e /tmp/family-archive-config-function
chmod 0620 "$TEST_ROOT/config-cases/valid.env"
assert_failure 'config с group-write отклоняется' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; preparse_config --config '$TEST_ROOT/config-cases/valid.env'; load_config"
chmod 0600 "$TEST_ROOT/config-cases/valid.env"

printf '%s\n' 'INSTALL_ROOT=relative/path' > "$TEST_ROOT/config-cases/bad-path.env"
printf '%s\n' 'SERVICE_USER=Bad.User' > "$TEST_ROOT/config-cases/bad-user.env"
printf '%s\n' 'REPOSITORY_URL=http://example.invalid/repository.git' > "$TEST_ROOT/config-cases/bad-url.env"
printf '%s\n' 'KEEP_RELEASES=0' > "$TEST_ROOT/config-cases/bad-number.env"
printf '%s\n' 'LISTEN_ADDRESS=127.0.0.1:70000' > "$TEST_ROOT/config-cases/bad-address.env"
printf '%s\n' 'POCKETBASE_VERSION=v0.39.10' > "$TEST_ROOT/config-cases/bad-version.env"
chmod 0600 "$TEST_ROOT/config-cases/"bad-*.env
for config_case in bad-path bad-user bad-url bad-number bad-address bad-version; do
  assert_failure "тип значения config проверяется: $config_case" bash -c \
    "source '$TEST_DIR/../lib/common.sh'; preparse_config --config '$TEST_ROOT/config-cases/$config_case.env'; load_config"
done

assert_success 'setup_traps объединяет существующий EXIT trap с cleanup' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; trap 'printf chained > \"$TEST_ROOT/trap-marker\"' EXIT; setup_traps; make_temp_dir chained_temp '$TEST_ROOT/trap-cleanup.XXXXXX'; printf '%s' \"\$chained_temp\" > '$TEST_ROOT/trap-path'"
assert_equal chained "$(cat "$TEST_ROOT/trap-marker")" 'существующий EXIT trap выполнен'
assert_success 'объединённый EXIT trap удалил временный каталог' test ! -e "$(cat "$TEST_ROOT/trap-path")"

mkdir -p "$TEST_ROOT/good/pb_data" "$TEST_ROOT/good/pb_migrations"
printf 'database' > "$TEST_ROOT/good/pb_data/data.db"
printf 'migration' > "$TEST_ROOT/good/pb_migrations/1.js"
tar -C "$TEST_ROOT/good" -czf "$TEST_ROOT/good.tar.gz" .
assert_success 'корректный backup проходит проверку' validate_tar_archive "$TEST_ROOT/good.tar.gz"
printf '%s  %s\n' "$(sha256sum "$TEST_ROOT/good.tar.gz" | awk '{print $1}')" good.tar.gz \
  > "$TEST_ROOT/good.tar.gz.sha256"
assert_success 'checksum backup проверяется с ожидаемым именем' verify_backup_checksum "$TEST_ROOT/good.tar.gz"
printf '%064d  other.tar.gz\n' 0 > "$TEST_ROOT/good.tar.gz.sha256"
assert_failure 'checksum с чужим именем отклоняется' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; verify_backup_checksum '$TEST_ROOT/good.tar.gz'"

tar -C "$TEST_ROOT/good" --transform='s|^|../|' -czf "$TEST_ROOT/parent.tar.gz" pb_data
assert_failure 'backup с ../ отклоняется' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; validate_tar_archive '$TEST_ROOT/parent.tar.gz'"

tar -C "$TEST_ROOT/good" --transform='s|^|/etc/|' -czf "$TEST_ROOT/absolute.tar.gz" pb_data
assert_failure 'backup с абсолютным путём отклоняется' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; validate_tar_archive '$TEST_ROOT/absolute.tar.gz'"

mkdir -p "$TEST_ROOT/link/pb_data"
ln -s /etc/passwd "$TEST_ROOT/link/pb_data/passwd-link"
tar -C "$TEST_ROOT/link" -czf "$TEST_ROOT/link.tar.gz" .
assert_failure 'backup с symlink отклоняется' bash -c \
  "source '$TEST_DIR/../lib/common.sh'; validate_tar_archive '$TEST_ROOT/link.tar.gz'"

mkdir -p "$TEST_ROOT/extracted"
assert_success 'проверенный backup распаковывается во временный каталог' \
  extract_verified_backup "$TEST_ROOT/good.tar.gz" "$TEST_ROOT/extracted"
assert_success 'распакованные данные присутствуют' test -f "$TEST_ROOT/extracted/pb_data/data.db"

run_restore_helper() {
  local archive=$1 install_root=$2 temp_root=$3 mock_bin=${4:-}
  # shellcheck disable=SC2016 # Переменные относятся к отдельному тестовому bash-процессу.
  env PATH="${mock_bin:+$mock_bin:}$PATH" TMPDIR="$temp_root" \
    bash -c '
      set -Eeuo pipefail
      source "$1"
      setup_traps
      INSTALL_ROOT=$2
      SERVICE_USER=$3
      SERVICE_GROUP=$4
      restore_data_from_backup "$5" test-failure
    ' _ "$TEST_DIR/../lib/common.sh" "$install_root" "$(id -un)" "$(id -gn)" "$archive"
}

assert_restore_temps_absent() {
  local name=$1 temp_root=$2 install_root=$3 found
  found="$(find "$temp_root" "$install_root/shared" -maxdepth 1 -type d \
    \( -name 'family-archive-restore.*' -o -name '.pb-data-restore.*' \) -print -quit)"
  assert_equal '' "$found" "$name"
}

RESTORE_ROOT="$TEST_ROOT/restore-root"
RESTORE_TMP="$TEST_ROOT/restore-tmp"
mkdir -p "$RESTORE_ROOT/shared/pb_data" "$RESTORE_TMP"
printf 'before' > "$RESTORE_ROOT/shared/pb_data/data.db"
INSTALL_ROOT=$RESTORE_ROOT
SERVICE_USER="$(id -un)"
SERVICE_GROUP="$(id -gn)"
TMPDIR=$RESTORE_TMP
restore_data_from_backup "$TEST_ROOT/good.tar.gz" successful
assert_equal database "$(cat "$RESTORE_ROOT/shared/pb_data/data.db")" 'успешный restore публикует данные backup'
assert_equal before "$(cat "$RESTORED_PREVIOUS_DATA/data.db")" 'успешный restore сохраняет предыдущие данные'
assert_restore_temps_absent 'успешный restore удаляет временные каталоги' "$RESTORE_TMP" "$RESTORE_ROOT"

printf 'not a tar archive\n' > "$TEST_ROOT/broken.tar.gz"
assert_failure 'ошибка архива прерывает restore' \
  run_restore_helper "$TEST_ROOT/broken.tar.gz" "$RESTORE_ROOT" "$RESTORE_TMP"
assert_restore_temps_absent 'ошибка архива не оставляет временные каталоги' "$RESTORE_TMP" "$RESTORE_ROOT"
assert_failure 'path traversal прерывает restore' \
  run_restore_helper "$TEST_ROOT/parent.tar.gz" "$RESTORE_ROOT" "$RESTORE_TMP"
assert_restore_temps_absent 'path traversal не оставляет временные каталоги' "$RESTORE_TMP" "$RESTORE_ROOT"

mkdir -p "$TEST_ROOT/mock-rsync"
printf '%s\n' '#!/usr/bin/env bash' 'exit 71' > "$TEST_ROOT/mock-rsync/rsync"
chmod 0755 "$TEST_ROOT/mock-rsync/rsync"
assert_failure 'ошибка копирования прерывает restore' \
  run_restore_helper "$TEST_ROOT/good.tar.gz" "$RESTORE_ROOT" "$RESTORE_TMP" "$TEST_ROOT/mock-rsync"
assert_restore_temps_absent 'ошибка копирования не оставляет временные каталоги' "$RESTORE_TMP" "$RESTORE_ROOT"

mkdir -p "$TEST_ROOT/mock-signal"
# shellcheck disable=SC2016 # PPID должен раскрываться только внутри mock tar.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'kill -TERM "$PPID"' \
  'sleep 0.1' \
  'exit 143' \
  > "$TEST_ROOT/mock-signal/tar"
chmod 0755 "$TEST_ROOT/mock-signal/tar"
assert_failure 'TERM во время проверки архива прерывает restore' \
  run_restore_helper "$TEST_ROOT/good.tar.gz" "$RESTORE_ROOT" "$RESTORE_TMP" "$TEST_ROOT/mock-signal"
assert_restore_temps_absent 'TERM не оставляет временные каталоги restore' "$RESTORE_TMP" "$RESTORE_ROOT"

CUTOVER_ORDER=()
cutover_test_stop() { CUTOVER_ORDER+=(stop); }
cutover_test_backup() { CUTOVER_ORDER+=(backup); }
cutover_test_migrate() { CUTOVER_ORDER+=(migrate); }
cutover_test_switch() { CUTOVER_ORDER+=(switch); }
cutover_test_start() { CUTOVER_ORDER+=(start); }
cutover_test_health() { CUTOVER_ORDER+=(health); }
run_update_cutover_steps cutover_test_stop cutover_test_backup cutover_test_migrate \
  cutover_test_switch cutover_test_start cutover_test_health
assert_equal 'stop backup migrate switch start health' "${CUTOVER_ORDER[*]}" \
  'cutover выполняется в безопасном порядке'
set_default_config
unset TMPDIR

mkdir -p "$TEST_ROOT/releases/one" "$TEST_ROOT/releases/two"
atomic_symlink "$TEST_ROOT/releases/one" "$TEST_ROOT/current"
atomic_symlink "$TEST_ROOT/releases/two" "$TEST_ROOT/current"
assert_equal "$TEST_ROOT/releases/two" "$(readlink -f "$TEST_ROOT/current")" 'symlink release переключается атомарно'

write_release_metadata "$TEST_ROOT/releases/two" \
  '0123456789abcdef0123456789abcdef01234567' 'v-test' 'main' '0.3.0'
assert_equal '0123456789abcdef0123456789abcdef01234567' \
  "$(read_release_value "$TEST_ROOT/releases/two" COMMIT)" 'metadata release читается без потери commit'
assert_equal '0.3.0' "$(read_release_value "$TEST_ROOT/releases/two" APP_VERSION)" \
  'metadata release содержит версию приложения'

mkdir -p "$TEST_ROOT/release-permissions/"{pb_public,pb_migrations,config,scripts}
printf '#!/bin/sh\n' > "$TEST_ROOT/release-permissions/pocketbase"
chmod 0755 "$TEST_ROOT/release-permissions/pocketbase"
chmod 0700 "$TEST_ROOT/release-permissions"
write_release_metadata "$TEST_ROOT/release-permissions" \
  '1123456789abcdef0123456789abcdef01234567' 'v-permissions' 'main'
finalize_release_permissions "$TEST_ROOT/release-permissions"
assert_equal 755 "$(stat -c '%a' "$TEST_ROOT/release-permissions")" \
  'корень release доступен системному пользователю'
assert_success 'полный release проходит проверку целостности' \
  release_is_valid "$TEST_ROOT/release-permissions"

INSTALL_ROOT="$TEST_ROOT/valid-current-root"
mkdir -p "$INSTALL_ROOT/releases"
mv "$TEST_ROOT/release-permissions" "$INSTALL_ROOT/releases/valid"
atomic_symlink "$INSTALL_ROOT/releases/valid" "$INSTALL_ROOT/current"
assert_equal "$INSTALL_ROOT/releases/valid" "$(current_release)" \
  'current принимается только для полного release внутри releases'
atomic_symlink "$TEST_ROOT/releases/two" "$INSTALL_ROOT/current"
assert_failure 'неполный current release отклоняется' current_release

INSTALL_ROOT="$TEST_ROOT/install-root"
mkdir -p "$INSTALL_ROOT"
write_systemd_unit "$TEST_ROOT/systemd/family-tree.service"
assert_success 'unit использует атомарный current release' \
  grep -q "WorkingDirectory=$INSTALL_ROOT/current" "$TEST_ROOT/systemd/family-tree.service"
assert_success 'unit запрещает runtime-миграции' \
  grep -q -- '--automigrate=false' "$TEST_ROOT/systemd/family-tree.service"
assert_success 'unit разрешает запись только в shared/pb_data' \
  grep -q "^ReadWritePaths=$INSTALL_ROOT/shared/pb_data$" "$TEST_ROOT/systemd/family-tree.service"

assert_success 'unit использует раздельные LISTEN_HOST и PORT' \
  grep -q -- "--http=$(listen_address)" "$TEST_ROOT/systemd/family-tree.service"
assert_success 'unit передаёт приложению сохранённый TIMEZONE' \
  grep -Fqx "Environment=TZ=$TIMEZONE" "$TEST_ROOT/systemd/family-tree.service"

write_install_config "$TEST_ROOT/config/deployment.env"
assert_equal 600 "$(stat -c '%a' "$TEST_ROOT/config/deployment.env")" 'рабочий deployment.env имеет права 0600'

INSTALL_ROOT="$TEST_ROOT/cli-root"
FAMILY_ARCHIVE_CLI_BIN_DIR="$TEST_ROOT/cli-bin"
FAMILY_ARCHIVE_CLI_TEST_MODE=1
FAMILY_ARCHIVE_CLI_EXPECTED_UID=$(id -u)
FAMILY_ARCHIVE_CLI_EXPECTED_GID=$(id -g)
TMPDIR=$TEST_ROOT
export FAMILY_ARCHIVE_CLI_BIN_DIR FAMILY_ARCHIVE_CLI_TEST_MODE
export FAMILY_ARCHIVE_CLI_EXPECTED_UID FAMILY_ARCHIVE_CLI_EXPECTED_GID TMPDIR
mkdir -p "$INSTALL_ROOT/releases/one/scripts" "$INSTALL_ROOT/releases/two/scripts"
# shellcheck disable=SC2016 # Аргументы записываются только при запуске тестового launcher target.
printf '%s\n' '#!/usr/bin/env bash' 'printf "one\n" > "$CLI_RELEASE_RECORD"' \
  'printf "%s\n" "$@" > "$CLI_ARGUMENT_RECORD"' \
  > "$INSTALL_ROOT/releases/one/scripts/family-archive.sh"
# shellcheck disable=SC2016 # Аргументы записываются только при запуске тестового launcher target.
printf '%s\n' '#!/usr/bin/env bash' 'printf "two\n" > "$CLI_RELEASE_RECORD"' \
  'printf "%s\n" "$@" > "$CLI_ARGUMENT_RECORD"' \
  > "$INSTALL_ROOT/releases/two/scripts/family-archive.sh"
chmod 0755 "$INSTALL_ROOT/releases/"{one,two}/scripts/family-archive.sh
atomic_symlink "$INSTALL_ROOT/releases/one" "$INSTALL_ROOT/current"
CLI_RELEASE_RECORD="$TEST_ROOT/cli-release-record"
CLI_ARGUMENT_RECORD="$TEST_ROOT/cli-argument-record"
export CLI_RELEASE_RECORD CLI_ARGUMENT_RECORD

install_cli_launchers
assert_equal installed "$(cli_installation_state)" 'install создаёт все пять CLI launchers'
# shellcheck disable=SC2016 # Positional parameter belongs to child bash.
assert_success 'основной launcher является обычным файлом mode 0755' \
  bash -c '[[ -f $1 && ! -L $1 && $(stat -c %a "$1") == 755 ]]' _ \
    "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive"
# shellcheck disable=SC2016 # Positional parameter belongs to child bash.
assert_success 'launchers не содержат eval и не зависят от release-id' \
  bash -c '! grep -R -E "(^|[[:space:]])eval([[:space:]]|$)|releases/(one|two)" "$1"' _ \
    "$FAMILY_ARCHIVE_CLI_BIN_DIR"
commit_cli_transaction

# shellcheck disable=SC2016 # Literal payload verifies that launchers do not evaluate arguments.
"$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive" alpha 'два слова' '--literal=$()'
assert_equal $'alpha\nдва слова\n--literal=$()' "$(cat "$CLI_ARGUMENT_RECORD")" \
  'главный launcher передаёт аргументы без изменений'
"$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive-backup" '--keep=3' 'два слова'
assert_equal $'backup\n--keep=3\nдва слова' "$(cat "$CLI_ARGUMENT_RECORD")" \
  'совместимый launcher добавляет subcommand и сохраняет аргументы'

atomic_symlink "$INSTALL_ROOT/releases/two" "$INSTALL_ROOT/current"
"$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive" version
assert_equal two "$(cat "$CLI_RELEASE_RECORD")" 'launchers работают после переключения current'

touch -t 200001010000 "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive"
launcher_mtime=$(stat -c '%Y' "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive")
install_cli_launchers
assert_equal "$launcher_mtime" "$(stat -c '%Y' "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive")" \
  'корректный launcher не переписывается'
commit_cli_transaction

rm -f -- "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive-status"
assert_equal invalid "$(cli_installation_state)" 'частичный набор CLI распознаётся как invalid'
install_cli_launchers
assert_equal installed "$(cli_installation_state)" 'update восстанавливает отсутствующий launcher'
commit_cli_transaction

printf 'damaged\n' > "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive-update"
chmod 0700 "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive-update"
install_cli_launchers
assert_success 'повреждённый launcher заменяется корректным' \
  cli_launcher_is_valid "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive-update"
commit_cli_transaction

remove_cli_launchers
printf 'старый launcher\n' > "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive"
chmod 0711 "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive"
install_cli_launchers
restore_cli_launchers
assert_equal 'старый launcher' "$(cat "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive")" \
  'rollback восстанавливает прежний launcher'
assert_equal 711 "$(stat -c '%a' "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive")" \
  'rollback восстанавливает прежние права launcher'
# shellcheck disable=SC2016 # Positional parameters belong to child bash.
assert_success 'rollback удаляет launchers, которых раньше не было' \
  bash -c 'for name in update backup rollback status; do [[ ! -e "$1/family-archive-$name" ]]; done' _ \
    "$FAMILY_ARCHIVE_CLI_BIN_DIR"
rm -f -- "$FAMILY_ARCHIVE_CLI_BIN_DIR/family-archive"

assert_success 'launcher показывает справку без production-действий' \
  "$PROJECT_ROOT/scripts/family-archive.sh" --help
assert_success 'doctor показывает справку без production-действий' \
  "$PROJECT_ROOT/scripts/doctor-server.sh" --help
assert_success 'version показывает справку без production-действий' \
  "$PROJECT_ROOT/scripts/version-server.sh" --help
assert_success 'logs показывает справку без production-действий' \
  "$PROJECT_ROOT/scripts/logs-server.sh" --help
assert_success 'installer показывает dry-run/yes справку без production-действий' \
  "$PROJECT_ROOT/scripts/install-server.sh" --help
assert_success 'updater показывает dry-run/yes справку без production-действий' \
  "$PROJECT_ROOT/scripts/update-server.sh" --help
assert_success 'legacy migrator показывает dry-run/yes справку без production-действий' \
  "$PROJECT_ROOT/scripts/migrate-legacy-server.sh" --help
unset FAMILY_ARCHIVE_CLI_BIN_DIR FAMILY_ARCHIVE_CLI_TEST_MODE
unset FAMILY_ARCHIVE_CLI_EXPECTED_UID FAMILY_ARCHIVE_CLI_EXPECTED_GID

printf '1..%s\n' "$((PASSED + FAILED))"
if (( FAILED )); then
  printf 'Провалено: %s; успешно: %s\n' "$FAILED" "$PASSED" >&2
  exit 1
fi
printf 'Все deployment-тесты прошли: %s\n' "$PASSED"
