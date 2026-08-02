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
    '  show) if [[ $* == *"FragmentPath"* ]]; then if [[ ${MOCK_FRAGMENT_PATH_SET:-0} == 1 ]]; then printf "%s\n" "${MOCK_FRAGMENT_PATH_OVERRIDE:-}"; else printf "%s\n" "$MOCK_UNIT_PATH"; fi; elif [[ $* == *"ExecStart"* ]]; then sed -n "s/^ExecStart=//p" "$MOCK_UNIT_PATH"; elif [[ $* == *"DropInPaths"* ]]; then :; elif [[ $* == *"DynamicUser"* ]]; then sed -n "s/^DynamicUser=//p" "$MOCK_UNIT_PATH"; elif [[ $* == *"--property=User"* ]]; then sed -n "s/^User=//p" "$MOCK_UNIT_PATH"; elif [[ $* == *"--property=Group"* ]]; then sed -n "s/^Group=//p" "$MOCK_UNIT_PATH"; fi ;;' \
    '  is-active) [[ $(cat "$MOCK_SERVICE_STATE") == active ]] ;;' \
    '  is-enabled) [[ $(cat "$MOCK_ENABLED_STATE") == enabled ]] ;;' \
    '  stop) printf inactive > "$MOCK_SERVICE_STATE" ;;' \
    '  start) if [[ ${MOCK_FAIL_RESTART_AFTER_FINAL:-0} == 1 && $(grep -c "^stop" "$MOCK_SYSTEMCTL_LOG") -ge 2 ]]; then exit 1; fi; printf active > "$MOCK_SERVICE_STATE" ;;' \
    '  reset-failed) : ;;' \
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
    'printf "%s\n" "$last" >> "$MOCK_CURL_LOG"' \
    'if [[ -n $output && $output != /dev/null ]]; then cp "$MOCK_POCKETBASE_ZIP" "$output"; exit 0; fi' \
    'if [[ -f ${MOCK_LEGACY_HEALTH_FAIL_FILE:-/nonexistent} ]] && grep -q "/legacy/pocketbase" "$MOCK_UNIT_PATH"; then if (( write_status )); then printf 503; fi; exit 22; fi' \
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
  # shellcheck disable=SC2016 # Переменные раскрываются при запуске mock journalctl.
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >> "$MOCK_JOURNAL_LOG"' 'printf "mock legacy journal\n" >&2' > "$bin/journalctl"
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
  local root=$1 legacy unit_dir state=${2:-active} service_user service_group
  service_user=$(id -un)
  service_group=$(id -gn)
  legacy="$root/legacy"
  unit_dir="$root/systemd"
  mkdir -p "$legacy/"{pb_data,pb_migrations,pb_public,frontend,scripts,systemd} \
    "$unit_dir" "$root/config" "$root/lock"
  chmod 0755 "$legacy"
  printf legacy-binary > "$legacy/pocketbase"
  chmod 0755 "$legacy/pocketbase"
  printf before > "$legacy/pb_data/data.db"
  printf 'migration\n' > "$legacy/pb_migrations/1.js"
  printf 'legacy-public\n' > "$legacy/pb_public/index.html"
  printf '%s\n' '[Unit]' '[Service]' \
    "User=$service_user" \
    "Group=$service_group" \
    "ExecStart=$legacy/pocketbase serve --http=0.0.0.0:8090" \
    > "$unit_dir/family-tree.service"
  printf '%s' "$state" > "$root/service-state"
  printf enabled > "$root/enabled-state"
  : > "$root/systemctl.log"
  : > "$root/curl.log"
  : > "$root/journal.log"
}

run_migration() {
  local root=$1 failpoint=${2:-} extra=${3:-} install_root=${4:-} checksum systemd_dir unit_path
  [[ -n $install_root ]] || install_root="$root/legacy"
  systemd_dir=${MIGRATION_TEST_SYSTEMD_DIR:-$root/systemd}
  unit_path=${MIGRATION_TEST_UNIT_PATH:-$systemd_dir/family-tree.service}
  checksum=$(sha256sum "$root/pocketbase.zip" | awk '{print $1}')
  env PATH="$root/mock-bin:$PATH" \
    TMPDIR="$root" \
    FAMILY_ARCHIVE_MIGRATION_TEST_MODE=1 \
    FAMILY_ARCHIVE_CLI_TEST_MODE=1 \
    FAMILY_ARCHIVE_CLI_BIN_DIR="$root/cli-bin" \
    FAMILY_ARCHIVE_CLI_EXPECTED_UID="$(id -u)" \
    FAMILY_ARCHIVE_CLI_EXPECTED_GID="$(id -g)" \
    FAMILY_ARCHIVE_MIGRATION_TEST_FAIL="$failpoint" \
    FAMILY_ARCHIVE_MIGRATION_TEST_POCKETBASE_SHA256="$checksum" \
    FAMILY_ARCHIVE_SYSTEMD_DIR="$systemd_dir" \
    FAMILY_ARCHIVE_CONFIG_DIR="$root/config" \
    FAMILY_ARCHIVE_LOCK_DIR="$root/lock" \
    MOCK_UNIT_PATH="$unit_path" \
    MOCK_FRAGMENT_PATH_SET="${MOCK_FRAGMENT_PATH_SET:-0}" \
    MOCK_FRAGMENT_PATH_OVERRIDE="${MOCK_FRAGMENT_PATH_OVERRIDE:-}" \
    MOCK_SERVICE_STATE="$root/service-state" \
    MOCK_ENABLED_STATE="$root/enabled-state" \
    MOCK_SYSTEMCTL_LOG="$root/systemctl.log" \
    MOCK_CURL_LOG="$root/curl.log" \
    MOCK_JOURNAL_LOG="$root/journal.log" \
    MOCK_FAIL_RESTART_AFTER_FINAL="$([[ -f $root/fail-start ]] && printf 1 || printf 0)" \
    MOCK_LEGACY_HEALTH_FAIL_FILE="$root/fail-legacy-health" \
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

new_case case_root etc-fragment
mkdir -p "$case_root/etc/systemd/system"
mv "$case_root/systemd/family-tree.service" "$case_root/etc/systemd/system/family-tree.service"
rmdir "$case_root/systemd"
if MIGRATION_TEST_SYSTEMD_DIR="$case_root/etc/systemd/system" \
  MIGRATION_TEST_UNIT_PATH="$case_root/etc/systemd/system/family-tree.service" \
  run_migration "$case_root" '' --dry-run >/dev/null; then
  pass 'фактический FragmentPath /etc/systemd/system используется без заранее заданного имени пути'
else
  fail 'фактический FragmentPath /etc/systemd/system не принят'
fi

new_case case_root empty-fragment
if output=$(MOCK_FRAGMENT_PATH_SET=1 MOCK_FRAGMENT_PATH_OVERRIDE='' \
  run_migration "$case_root" '' --dry-run 2>&1); then
  fail 'пустой FragmentPath должен отклоняться'
elif [[ $output == *'пустой или не абсолютный FragmentPath'* ]]; then
  pass 'пустой FragmentPath отклоняется до изменений'
else
  fail 'пустой FragmentPath отклонён без ожидаемой диагностики'
fi
assert_file_value active "$case_root/service-state" 'пустой FragmentPath не останавливает unit'

new_case case_root relative-fragment
if output=$(MOCK_FRAGMENT_PATH_SET=1 MOCK_FRAGMENT_PATH_OVERRIDE='family-tree.service' \
  run_migration "$case_root" '' --dry-run 2>&1); then
  fail 'относительный FragmentPath должен отклоняться'
elif [[ $output == *'пустой или не абсолютный FragmentPath'* ]]; then
  pass 'относительный FragmentPath отклоняется до изменений'
else
  fail 'относительный FragmentPath отклонён без ожидаемой диагностики'
fi

new_case case_root missing-unit
rm "$case_root/systemd/family-tree.service"
if output=$(run_migration "$case_root" '' --dry-run 2>&1); then
  fail 'отсутствующий unit из FragmentPath должен отклоняться'
elif [[ $output == *'из FragmentPath отсутствует'* ]]; then
  pass 'отсутствующий unit из FragmentPath отклоняется'
else
  fail 'отсутствующий unit отклонён без ожидаемой диагностики'
fi
assert_file_value active "$case_root/service-state" 'отсутствующий unit не останавливает сервис'

new_case case_root escaping-symlink
mv "$case_root/systemd/family-tree.service" "$case_root/outside-family-tree.service"
ln -s ../outside-family-tree.service "$case_root/systemd/family-tree.service"
if output=$(run_migration "$case_root" '' --dry-run 2>&1); then
  fail 'symlink unit за пределы systemd-каталогов должен отклоняться'
elif [[ $output == *'выходит за разрешённые systemd-каталоги'* ]]; then
  pass 'symlink unit за пределы systemd-каталогов отклоняется'
else
  fail 'небезопасный symlink unit отклонён без ожидаемой диагностики'
fi

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

new_case case_root final-backup-error
if output=$(run_migration "$case_root" final-backup 2>&1); then
  fail 'ошибка final-offline-backup должна вернуть ненулевой код'
else
  pass 'ошибка final-offline-backup после остановки возвращает ненулевой код'
fi
assert_file_value active "$case_root/service-state" 'rollback final backup повторно запускает legacy-сервис'
assert_success 'rollback final backup выполняет reset-failed' \
  grep -Fqx 'reset-failed family-tree' "$case_root/systemctl.log"
assert_success 'rollback проверяет /api/health старого сервиса' \
  grep -Fqx 'http://127.0.0.1:8090/api/health' "$case_root/curl.log"
if [[ $output == *'service: restored'* && $output == *'result: COMPLETE'* &&
  $output == *'data: not-required'* && $output == *'unit: '*'(not-required)'* ]]; then
  pass 'успешный ранний rollback помечен COMPLETE без восстановления unit и данных'
else
  fail 'отчёт успешного раннего rollback неполон'
fi

new_case case_root final-backup-restart-error
touch "$case_root/fail-start"
if output=$(run_migration "$case_root" final-backup 2>&1); then
  fail 'ошибка повторного запуска legacy должна вернуть ненулевой код'
else
  pass 'ошибка повторного запуска legacy возвращает ненулевой код'
fi
if [[ $output == *'service: FAILED'* && $output == *'result: INCOMPLETE'* ]]; then
  pass 'ошибка повторного запуска формирует INCOMPLETE'
else
  fail 'ошибка повторного запуска не сформировала INCOMPLETE'
fi
assert_success 'при ошибке повторного запуска запрошены 100 строк journalctl' \
  grep -Fqx -- '-u family-tree -n 100 --no-pager' "$case_root/journal.log"
# shellcheck disable=SC2016 # Glob раскрывается внутри отдельного bash-процесса.
assert_success 'ошибка повторного запуска сохраняет recovery artifacts' \
  bash -c 'compgen -G "$1/.family-archive-legacy-migration.*" >/dev/null' _ "$case_root"

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
mkdir -p "$case_root/cli-bin"
chmod 0755 "$case_root/cli-bin"
printf 'прежний launcher\n' > "$case_root/cli-bin/family-archive"
chmod 0711 "$case_root/cli-bin/family-archive"
assert_failure 'ошибка health check запускает rollback' run_migration "$case_root" health
assert_file_value before "$case_root/legacy/pb_data/data.db" 'rollback health failure отменяет применённую миграцию'
assert_file_value active "$case_root/service-state" 'health rollback возвращает active legacy unit'
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'неудачная новая установка сохранена для расследования' \
  bash -c 'compgen -G "$1/legacy.failed-migration-*" >/dev/null' _ "$case_root"
assert_file_value 'прежний launcher' "$case_root/cli-bin/family-archive" \
  'rollback миграции восстанавливает прежний CLI launcher'
# shellcheck disable=SC2016 # Positional parameters belong to child bash.
assert_success 'rollback миграции удаляет новые CLI launchers' \
  bash -c 'for name in update backup rollback status; do [[ ! -e "$1/family-archive-$name" ]]; done' _ \
    "$case_root/cli-bin"
# shellcheck disable=SC2016 # Positional parameter belongs to child bash.
assert_success 'rollback миграции восстанавливает прежний mode launcher' \
  bash -c '[[ $(stat -c %a "$1") == 711 ]]' _ "$case_root/cli-bin/family-archive"

new_case case_root active-unit
assert_success 'активный legacy unit мигрирует с двумя offline окнами' run_migration "$case_root"
order=$(awk '$1 == "stop" || $1 == "start" {printf "%s ", $1}' "$case_root/systemctl.log")
if [[ $order == 'stop start stop start ' ]]; then
  pass 'active unit перезапускается после preflight и после cutover'
else
  fail "неверный порядок active unit: $order"
fi
assert_file_value migrated "$case_root/legacy/shared/pb_data/data.db" 'успешная миграция применяет схему к shared data'
# shellcheck disable=SC2016 # Подстановки выполняются внутри отдельного bash -c.
assert_success 'shared/pb_data после миграции принадлежит SERVICE_USER:SERVICE_GROUP' \
  bash -c '[[ $(stat -c "%U:%G" "$1/shared/pb_data") == "$(id -un):$(id -gn)" ]]' _ "$case_root/legacy"
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'deployment.env после миграции имеет mode 0600' \
  bash -c '[[ $(stat -c %a "$1/shared/deployment.env") == 600 ]]' _ "$case_root/legacy"
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'успешная миграция создаёт current внутри releases' \
  bash -c '[[ -L $1/current && $(readlink -f "$1/current") == "$1/releases/"* ]]' _ "$case_root/legacy"
# shellcheck disable=SC2016 # Positional parameters belong to child bash.
assert_success 'успешная migration создаёт все CLI launchers' \
  bash -c 'for name in family-archive family-archive-update family-archive-backup family-archive-rollback family-archive-status; do [[ -f "$1/$name" && ! -L "$1/$name" && $(stat -c %a "$1/$name") == 755 ]]; done' _ \
    "$case_root/cli-bin"

bootstrap_mock="$case_root/bootstrap-mock"
mkdir -p "$bootstrap_mock"
# shellcheck disable=SC2016 # Mock делегирует только проверку bare repository.
printf '%s\n' '#!/usr/bin/env bash' 'set -eu' \
  'if [[ ${1:-} == --git-dir=* ]]; then exec /usr/bin/git "$@"; fi' \
  'destination=${!#}' 'mkdir -p "$destination/scripts"' \
  'cp "$BOOTSTRAP_UPDATE_STUB" "$destination/scripts/update-server.sh"' \
  'chmod 0755 "$destination/scripts/update-server.sh"' > "$bootstrap_mock/git"
# shellcheck disable=SC2016 # Arguments are intentionally expanded by the generated mock.
printf '%s\n' '#!/usr/bin/env bash' '[[ ${1:-} == -- ]] && shift' 'exec "$@"' > "$bootstrap_mock/sudo"
# shellcheck disable=SC2016 # Mock executes test -r/-w as the current sandbox user.
printf '%s\n' '#!/usr/bin/env bash' \
  'while (($#)); do [[ $1 == -- ]] && { shift; break; }; shift; done' \
  'exec "$@"' > "$bootstrap_mock/runuser"
# shellcheck disable=SC2016 # Stub фиксирует выбранное bootstrap действие.
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" > "$BOOTSTRAP_AFTER_MIGRATION_RECORD"' \
  > "$case_root/update-stub"
chmod 0755 "$bootstrap_mock/git" "$bootstrap_mock/sudo" "$bootstrap_mock/runuser" \
  "$case_root/update-stub"
if bootstrap_output=$(env PATH="$bootstrap_mock:$case_root/mock-bin:$PATH" TMPDIR="$case_root" \
  FAMILY_ARCHIVE_BOOTSTRAP_TEST_MODE=1 \
  FAMILY_ARCHIVE_BOOTSTRAP_INSTALL_ROOT="$case_root/legacy" \
  FAMILY_ARCHIVE_BOOTSTRAP_EXPECTED_OWNER_UID="$(id -u)" \
  FAMILY_ARCHIVE_BOOTSTRAP_EXPECTED_OWNER_GID="$(id -g)" \
  BOOTSTRAP_UPDATE_STUB="$case_root/update-stub" \
  BOOTSTRAP_AFTER_MIGRATION_RECORD="$case_root/bootstrap-after-migration.record" \
  bash "$PROJECT_ROOT/scripts/bootstrap.sh" --dry-run 2>&1); then
  if [[ $bootstrap_output == *'Обнаружена release-установка.'* &&
    $bootstrap_output == *'Действие: обновление.'* ]]; then
    pass 'после успешной mock migration bootstrap выбирает update'
  else
    fail 'bootstrap после migration не сообщил release update'
  fi
else
  fail 'bootstrap не принял layout успешной mock migration'
fi
archive=$(find "$case_root" -maxdepth 1 -type d -name 'legacy.legacy-*' -print -quit)
assert_success 'старая плоская установка сохранена под timestamp-именем' test -x "$archive/pocketbase"
assert_success 'по умолчанию legacy pb_data указывает на единственную рабочую базу' test -L "$archive/pb_data"
backup_count=$(find "$case_root/legacy/backups" -maxdepth 1 -type f -name '*.tar.gz' | wc -l)
if [[ $backup_count == 2 ]]; then
  pass 'после успеха сохранены оба проверенных backup'
else
  fail 'не сохранены два backup'
fi

new_case case_root symlink-unit
mv "$case_root/systemd/family-tree.service" "$case_root/systemd/legacy-family-tree.service"
ln -s legacy-family-tree.service "$case_root/systemd/family-tree.service"
assert_success 'безопасный symlink FragmentPath проходит полную миграцию' run_migration "$case_root"
assert_success 'запись нового unit сохраняет безопасный symlink' test -L "$case_root/systemd/family-tree.service"
backup=$(find "$case_root/legacy/backups" -type f -name '*-final.tar.gz' -print -quit)
listing=$(tar -tzf "$backup")
if grep -Eq '^(\./)?systemd/family-tree\.service$' <<< "$listing"; then
  pass 'backup содержит unit под стабильным внутренним путём systemd/family-tree.service'
else
  fail 'backup не содержит unit под стабильным внутренним путём'
fi
if grep -Eq '^(\./)?pb_data(/|$)' <<< "$listing" &&
  grep -Eq '^(\./)?metadata\.json$' <<< "$listing"; then
  pass 'проверка listing видит unit, pb_data и metadata'
else
  fail 'проверка listing не видит обязательные элементы backup'
fi
metadata=$(tar -xOzf "$backup" ./metadata.json 2>/dev/null || tar -xOzf "$backup" metadata.json)
if [[ $(jq -r .fragment_path <<< "$metadata") == "$case_root/systemd/family-tree.service" ]]; then
  pass 'metadata сохраняет исходный symlink FragmentPath'
else
  fail 'metadata не сохранила исходный FragmentPath'
fi
# shellcheck disable=SC2016 # Аргументы раскрываются внутри отдельного bash-процесса.
assert_success 'SHA-256 final backup создан и проверяется' \
  bash -c 'cd "$(dirname "$1")" && sha256sum --check --status "$(basename "$1").sha256"' _ "$backup"

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
