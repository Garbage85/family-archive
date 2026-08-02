#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_PROJECT_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
INSTALLER="$TEST_PROJECT_ROOT/scripts/install-server.sh"
SUITE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/family-archive-setup-tests.XXXXXX")
MOCK_BIN="$SUITE_ROOT/mock-bin"
PASSED=0
FAILED=0

cleanup() {
  [[ -d $SUITE_ROOT ]] && rm -rf -- "$SUITE_ROOT"
}
trap cleanup EXIT

pass() { PASSED=$((PASSED + 1)); printf 'ok setup %s - %s\n' "$PASSED" "$1"; }
fail() { FAILED=$((FAILED + 1)); printf 'not ok setup %s - %s\n' "$((PASSED + FAILED))" "$1" >&2; }
assert_contains() {
  local needle=$1 haystack=$2 name=$3
  if [[ $haystack == *"$needle"* ]]; then pass "$name"; else fail "$name"; fi
}
assert_success() { local name=$1; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
assert_failure() { local name=$1; shift; if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi; }

mkdir -p "$MOCK_BIN"
# shellcheck disable=SC2016 # Переменные нужны mock-процессу.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'requested=' \
  '[[ $* =~ sport[[:space:]]=[[:space:]]:([0-9]+) ]] && requested=${BASH_REMATCH[1]}' \
  'for port in ${MOCK_BUSY_PORTS:-}; do' \
  '  if [[ -z $requested || $requested == "$port" ]]; then printf "LISTEN 0 128 0.0.0.0:%s 0.0.0.0:* users:((mock,pid=42,fd=3))\\n" "$port"; fi' \
  'done' > "$MOCK_BIN/ss"
# shellcheck disable=SC2016 # Аргументы нужны mock-процессу.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'case "${1:-}" in' \
  '  cat) [[ -n ${MOCK_UNIT_PATH:-} ]] && cat "$MOCK_UNIT_PATH" || exit 1 ;;' \
  '  list-sockets) for port in ${MOCK_SOCKET_PORTS:-}; do printf "0.0.0.0:%s mock.socket mock.service\\n" "$port"; done ;;' \
  '  is-active) [[ -n ${MOCK_UNIT_PATH:-} ]] ;;' \
  '  is-enabled) [[ -n ${MOCK_UNIT_PATH:-} ]] ;;' \
  '  show) if [[ $* == *MainPID* ]]; then printf "42\\n"; else printf "0\\n"; fi ;;' \
  '  *) exit 0 ;;' \
  'esac' > "$MOCK_BIN/systemctl"
chmod 0755 "$MOCK_BIN/ss" "$MOCK_BIN/systemctl"

new_case() {
  local destination_var=$1 name=$2 root config
  root="$SUITE_ROOT/$name"
  config="$root/deployment.env"
  mkdir -p "$root"
  printf 'INSTALL_ROOT=%s/install\n' "$root" > "$config"
  chmod 0600 "$config"
  printf -v "$destination_var" '%s' "$root"
}

run_installer() {
  local root=$1 busy=$2 sockets=${MOCK_SOCKET_PORTS:-}
  shift 2
  env PATH="$MOCK_BIN:$PATH" TMPDIR="$root" MOCK_BUSY_PORTS="$busy" MOCK_SOCKET_PORTS="$sockets" \
    FAMILY_ARCHIVE_INSTALL_TEST_MODE=1 DEPLOYMENT_CONFIG="$root/deployment.env" \
    bash "$INSTALLER" --dry-run "$@" 2>&1
}

case_root=""
new_case case_root default-free
output=$(run_installer "$case_root" '' --yes)
assert_contains 'Port: 8090' "$output" 'свободный 8090 выбирается по умолчанию'

new_case case_root default-busy
output=$(run_installer "$case_root" '8090' --yes)
assert_contains 'Port: 8091' "$output" 'при занятом 8090 выбирается 8091'
assert_contains 'выбран свободный порт 8091' "$output" '--yes явно сообщает автоматически выбранный порт'

new_case case_root two-busy
output=$(run_installer "$case_root" '8090 8091' --yes)
assert_contains 'Port: 8092' "$output" 'занятые 8090 и 8091 пропускаются'

new_case case_root explicit-free
output=$(run_installer "$case_root" '' --yes --port 8095)
assert_contains 'Port: 8095' "$output" 'явный свободный порт принимается'

new_case case_root explicit-busy
assert_failure 'явный занятый порт отклоняется' run_installer "$case_root" '8095' --yes --port 8095
new_case case_root port-low
assert_failure 'порт ниже 1024 отклоняется' run_installer "$case_root" '' --yes --port 1023
new_case case_root port-high
assert_failure 'порт выше 65535 отклоняется' run_installer "$case_root" '' --yes --port 65536
new_case case_root port-text
assert_failure 'нечисловой порт отклоняется' run_installer "$case_root" '' --yes --port nope

new_case case_root no-mutation
output=$(run_installer "$case_root" '' --yes --site-name 'Архив семьи' --timezone Asia/Chita --no-systemd)
assert_contains 'Site name: Архив семьи' "$output" 'неинтерактивные параметры отображаются в dry-run'
assert_success 'dry-run не создаёт install root' test ! -e "$case_root/install"

new_case case_root socket-busy
MOCK_SOCKET_PORTS=8095 assert_failure 'занятый systemd socket отклоняет явный порт' \
  run_installer "$case_root" '' --yes --port 8095

new_case case_root bad-timezone
assert_failure 'некорректный timezone отклоняется' run_installer "$case_root" '' --yes --timezone Mars/Olympus

new_case case_root wizard-defaults
wizard_command="env PATH=$MOCK_BIN:$PATH TMPDIR=$case_root MOCK_BUSY_PORTS= FAMILY_ARCHIVE_INSTALL_TEST_MODE=1 DEPLOYMENT_CONFIG=$case_root/deployment.env bash $INSTALLER --dry-run"
output=$(printf '\n\n\n\n\n' | script -qec "$wizard_command" /dev/null 2>&1)
assert_contains 'Family Archive — первоначальная настройка' "$output" 'интерактивный мастер запускается на TTY'
assert_contains '- имя сайта: Family Archive' "$output" 'мастер принимает значения по умолчанию'

new_case case_root wizard-cancel
wizard_command="env PATH=$MOCK_BIN:$PATH TMPDIR=$case_root MOCK_BUSY_PORTS= FAMILY_ARCHIVE_INSTALL_TEST_MODE=1 DEPLOYMENT_CONFIG=$case_root/deployment.env bash $INSTALLER --dry-run"
output=$(printf '\n\n\n\n\n' | script -qec "$wizard_command" /dev/null 2>&1)
assert_success 'мастер по умолчанию не меняет систему' test ! -e "$case_root/install"
output=$(printf '\n\n\n\nn\n' | script -qec "$wizard_command" /dev/null 2>&1)
assert_contains 'Установка отменена; изменений нет.' "$output" 'отмена мастера завершается без изменений'
assert_success 'отмена мастера не создаёт install root' test ! -e "$case_root/install"

transaction_root="$SUITE_ROOT/transaction"
mkdir -p "$transaction_root/install/shared" "$transaction_root/systemd" "$transaction_root/tmp"
(
  # shellcheck source=scripts/lib/common.sh
  source "$TEST_PROJECT_ROOT/scripts/lib/common.sh"
  set_default_config
  INSTALL_ROOT="$transaction_root/install"
  CONFIG_FILE="$transaction_root/deployment.env"
  PORT=8090
  write_install_config "$CONFIG_FILE"
  install -m 0600 "$CONFIG_FILE" "$INSTALL_ROOT/shared/deployment.env"
  write_systemd_unit "$transaction_root/systemd/family-tree.service"
  port_is_available() { return 0; }
  systemctl() { return 0; }
  wait_for_health() { [[ $PORT == 8096 ]]; }
  change_port_transaction 8096 "$CONFIG_FILE" "$INSTALL_ROOT/shared/deployment.env" \
    "$transaction_root/systemd/family-tree.service" "$transaction_root/recovery"
)
assert_success 'успешная смена порта обновляет config' grep -Fqx 'PORT=8096' "$transaction_root/deployment.env"
assert_success 'успешная смена порта обновляет unit' grep -q -- '--http=0.0.0.0:8096' "$transaction_root/systemd/family-tree.service"

rollback_root="$SUITE_ROOT/rollback"
mkdir -p "$rollback_root/install/shared" "$rollback_root/systemd" "$rollback_root/tmp"
set +e
(
  # shellcheck source=scripts/lib/common.sh
  source "$TEST_PROJECT_ROOT/scripts/lib/common.sh"
  set_default_config
  INSTALL_ROOT="$rollback_root/install"
  CONFIG_FILE="$rollback_root/deployment.env"
  PORT=8090
  write_install_config "$CONFIG_FILE"
  install -m 0600 "$CONFIG_FILE" "$INSTALL_ROOT/shared/deployment.env"
  write_systemd_unit "$rollback_root/systemd/family-tree.service"
  port_is_available() { return 0; }
  systemctl() { return 0; }
  wait_for_health() { [[ $PORT == 8090 ]]; }
  change_port_transaction 8096 "$CONFIG_FILE" "$INSTALL_ROOT/shared/deployment.env" \
    "$rollback_root/systemd/family-tree.service" "$rollback_root/recovery"
)
rollback_status=$?
set -e
if [[ $rollback_status != 0 ]]; then
  pass 'ошибка health check сообщает неуспех смены порта'
else
  fail 'ошибка health check сообщает неуспех смены порта'
fi
assert_success 'ошибка health check возвращает старый PORT' grep -Fqx 'PORT=8090' "$rollback_root/deployment.env"
assert_success 'ошибка health check возвращает старый unit' grep -q -- '--http=0.0.0.0:8090' "$rollback_root/systemd/family-tree.service"

preserve_root="$SUITE_ROOT/preserve"
mkdir -p "$preserve_root"
printf 'PORT=8123\nLISTEN_HOST=127.0.0.1\n' > "$preserve_root/deployment.env"
chmod 0600 "$preserve_root/deployment.env"
(
  # shellcheck source=scripts/lib/common.sh
  source "$TEST_PROJECT_ROOT/scripts/lib/common.sh"
  CONFIG_FILE="$preserve_root/deployment.env"
  CONFIG_FILE_EXPLICIT=1
  load_config
  write_install_config "$preserve_root/rewritten.env"
)
assert_success 'update-style чтение и запись сохраняет существующий PORT' \
  grep -Fqx 'PORT=8123' "$preserve_root/rewritten.env"

doctor_root="$SUITE_ROOT/doctor"
mkdir -p "$doctor_root/install/shared/pb_data" "$doctor_root/install/backups"
printf 'INSTALL_ROOT=%s/install\nPORT=8095\n' "$doctor_root" > "$doctor_root/deployment.env"
chmod 0600 "$doctor_root/deployment.env"
printf '%s\n' '[Service]' \
  "ExecStart=$doctor_root/install/current/pocketbase serve --http=0.0.0.0:8090" \
  > "$doctor_root/family-tree.service"
set +e
doctor_output=$(env PATH="$MOCK_BIN:$PATH" TMPDIR="$doctor_root" MOCK_BUSY_PORTS=8090 \
  MOCK_UNIT_PATH="$doctor_root/family-tree.service" FAMILY_ARCHIVE_DOCTOR_TEST_MODE=1 \
  DEPLOYMENT_CONFIG="$doctor_root/deployment.env" \
  bash "$TEST_PROJECT_ROOT/scripts/doctor-server.sh" 2>&1)
set -e
assert_contains 'Несовпадение config/unit: PORT=8095, unit слушает 8090' "$doctor_output" \
  'doctor обнаруживает несовпадение config и unit'
assert_contains 'Сервис слушает другой порт: 8090; в config указан 8095' "$doctor_output" \
  'doctor обнаруживает несовпадение config и listener'

printf 'Setup tests: %s passed, %s failed.\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
