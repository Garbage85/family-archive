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
# shellcheck disable=SC2016 # Владелец одного launcher моделируется без root/chown.
printf '%s\n' '#!/usr/bin/env bash' 'set -eu' 'target=${!#}' \
  'if [[ -n ${MOCK_BAD_CLI_OWNER:-} && $target == "$MOCK_BAD_CLI_OWNER" && ${1:-} == -c && ${2:-} == %u ]]; then printf "4242\n"; exit 0; fi' \
  'exec /usr/bin/stat "$@"' > "$MOCK_BIN/stat"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$MOCK_BIN/git"
printf '%s\n' '#!/usr/bin/env bash' 'exit 22' > "$MOCK_BIN/curl"
chmod 0755 "$MOCK_BIN/ss" "$MOCK_BIN/systemctl" "$MOCK_BIN/stat" \
  "$MOCK_BIN/git" "$MOCK_BIN/curl"

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

os_release_root="$SUITE_ROOT/os-release"
mkdir -p "$os_release_root"
printf 'ID=debian\nPRETTY_NAME="Debian GNU/Linux 12"\n' > "$os_release_root/debian"
printf 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04 LTS"\n' > "$os_release_root/ubuntu"
printf 'ID=raspbian\nID_LIKE=debian\nPRETTY_NAME="Raspberry Pi OS"\n' > "$os_release_root/raspbian"
printf 'ID=fedora\nPRETTY_NAME="Fedora Linux"\n' > "$os_release_root/unsupported"
for supported_os in debian ubuntu raspbian; do
  new_case case_root "os-$supported_os"
  export FAMILY_ARCHIVE_OS_RELEASE_FILE="$os_release_root/$supported_os"
  assert_success "installer распознаёт $supported_os через os-release" \
    run_installer "$case_root" '' --yes
done
new_case case_root os-unsupported
export FAMILY_ARCHIVE_OS_RELEASE_FILE="$os_release_root/unsupported"
assert_failure 'installer отклоняет неподдерживаемый os-release' \
  run_installer "$case_root" '' --yes
unset FAMILY_ARCHIVE_OS_RELEASE_FILE

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
mkdir -p "$doctor_root/install/shared/pb_data" "$doctor_root/install/backups" \
  "$doctor_root/install/current/scripts" "$doctor_root/install/current/pb_public/assets" \
  "$doctor_root/cli-bin"
chmod 0755 "$doctor_root/cli-bin"
printf 'INSTALL_ROOT=%s/install\nPORT=8095\n' "$doctor_root" > "$doctor_root/deployment.env"
chmod 0600 "$doctor_root/deployment.env"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' \
  > "$doctor_root/install/current/scripts/family-archive.sh"
chmod 0755 "$doctor_root/install/current/scripts/family-archive.sh"
printf '<!doctype html>\n' > "$doctor_root/install/current/pb_public/index.html"
printf 'console.log("fixture")\n' > "$doctor_root/install/current/pb_public/assets/app.js"
printf 'body {}\n' > "$doctor_root/install/current/pb_public/assets/app.css"
install_doctor_cli() {
  # shellcheck disable=SC2016 # Positional parameter belongs to child bash.
  env TMPDIR="$doctor_root" DEPLOYMENT_CONFIG="$doctor_root/deployment.env" \
    FAMILY_ARCHIVE_CLI_TEST_MODE=1 FAMILY_ARCHIVE_CLI_BIN_DIR="$doctor_root/cli-bin" \
    bash -c '
      set -Eeuo pipefail
      source "$1/scripts/lib/common.sh"
      load_config
      setup_traps
      install_cli_launchers
      commit_cli_transaction
    ' _ "$TEST_PROJECT_ROOT"
}
assert_success 'doctor fixture создаёт корректные CLI launchers' install_doctor_cli
printf '%s\n' '[Service]' \
  "ExecStart=$doctor_root/install/current/pocketbase serve --http=0.0.0.0:8090" \
  > "$doctor_root/family-tree.service"
set +e
doctor_output=$(env PATH="$MOCK_BIN:$PATH" TMPDIR="$doctor_root" MOCK_BUSY_PORTS=8090 \
  MOCK_UNIT_PATH="$doctor_root/family-tree.service" FAMILY_ARCHIVE_DOCTOR_TEST_MODE=1 \
  FAMILY_ARCHIVE_CLI_BIN_DIR="$doctor_root/cli-bin" \
  DEPLOYMENT_CONFIG="$doctor_root/deployment.env" \
  bash "$TEST_PROJECT_ROOT/scripts/doctor-server.sh" 2>&1)
set -e
assert_contains 'Несовпадение config/unit: PORT=8095, unit слушает 8090' "$doctor_output" \
  'doctor обнаруживает несовпадение config и unit'
assert_contains 'Сервис слушает другой порт: 8090; в config указан 8095' "$doctor_output" \
  'doctor обнаруживает несовпадение config и listener'
assert_contains 'Frontend assets присутствуют' "$doctor_output" \
  'doctor подтверждает обязательные frontend assets'

rm -f -- "$doctor_root/install/current/pb_public/assets/app.js"
set +e
doctor_assets_output=$(env PATH="$MOCK_BIN:$PATH" TMPDIR="$doctor_root" MOCK_BUSY_PORTS=8090 \
  MOCK_UNIT_PATH="$doctor_root/family-tree.service" FAMILY_ARCHIVE_DOCTOR_TEST_MODE=1 \
  FAMILY_ARCHIVE_CLI_BIN_DIR="$doctor_root/cli-bin" \
  DEPLOYMENT_CONFIG="$doctor_root/deployment.env" \
  bash "$TEST_PROJECT_ROOT/scripts/doctor-server.sh" 2>&1)
set -e
assert_contains 'Frontend assets отсутствуют или неполны' "$doctor_assets_output" \
  'doctor считает отсутствие frontend assets ошибкой'
printf 'console.log("fixture")\n' > "$doctor_root/install/current/pb_public/assets/app.js"

set +e
doctor_owner_output=$(env PATH="$MOCK_BIN:$PATH" TMPDIR="$doctor_root" MOCK_BUSY_PORTS=8090 \
  MOCK_UNIT_PATH="$doctor_root/family-tree.service" FAMILY_ARCHIVE_DOCTOR_TEST_MODE=1 \
  FAMILY_ARCHIVE_CLI_BIN_DIR="$doctor_root/cli-bin" \
  MOCK_BAD_CLI_OWNER="$doctor_root/cli-bin/family-archive" \
  DEPLOYMENT_CONFIG="$doctor_root/deployment.env" \
  bash "$TEST_PROJECT_ROOT/scripts/doctor-server.sh" 2>&1)
set -e
assert_contains 'CLI launcher имеет неправильного владельца' "$doctor_owner_output" \
  'doctor обнаруживает неправильного владельца launcher'

chmod 0700 "$doctor_root/cli-bin/family-archive-backup"
set +e
doctor_mode_output=$(env PATH="$MOCK_BIN:$PATH" TMPDIR="$doctor_root" MOCK_BUSY_PORTS=8090 \
  MOCK_UNIT_PATH="$doctor_root/family-tree.service" FAMILY_ARCHIVE_DOCTOR_TEST_MODE=1 \
  FAMILY_ARCHIVE_CLI_BIN_DIR="$doctor_root/cli-bin" \
  DEPLOYMENT_CONFIG="$doctor_root/deployment.env" \
  bash "$TEST_PROJECT_ROOT/scripts/doctor-server.sh" 2>&1)
set -e
assert_contains 'CLI launcher имеет неправильные права' "$doctor_mode_output" \
  'doctor обнаруживает неправильные права launcher'
chmod 0755 "$doctor_root/cli-bin/family-archive-backup"

printf '%s\n' '#!/usr/bin/env bash' 'exec /bin/false "$@"' \
  > "$doctor_root/cli-bin/family-archive-status"
chmod 0755 "$doctor_root/cli-bin/family-archive-status"
set +e
doctor_target_output=$(env PATH="$MOCK_BIN:$PATH" TMPDIR="$doctor_root" MOCK_BUSY_PORTS=8090 \
  MOCK_UNIT_PATH="$doctor_root/family-tree.service" FAMILY_ARCHIVE_DOCTOR_TEST_MODE=1 \
  FAMILY_ARCHIVE_CLI_BIN_DIR="$doctor_root/cli-bin" \
  DEPLOYMENT_CONFIG="$doctor_root/deployment.env" \
  bash "$TEST_PROJECT_ROOT/scripts/doctor-server.sh" 2>&1)
set -e
assert_contains 'CLI launcher имеет неправильный target или передачу аргументов' "$doctor_target_output" \
  'doctor обнаруживает неправильный target launcher'
assert_success 'повреждённый doctor launcher восстанавливается для status' install_doctor_cli

rm -f -- "$doctor_root/cli-bin/family-archive-rollback"
ln -s /bin/false "$doctor_root/cli-bin/family-archive-rollback"
set +e
doctor_symlink_output=$(env PATH="$MOCK_BIN:$PATH" TMPDIR="$doctor_root" MOCK_BUSY_PORTS=8090 \
  MOCK_UNIT_PATH="$doctor_root/family-tree.service" FAMILY_ARCHIVE_DOCTOR_TEST_MODE=1 \
  FAMILY_ARCHIVE_CLI_BIN_DIR="$doctor_root/cli-bin" \
  DEPLOYMENT_CONFIG="$doctor_root/deployment.env" \
  bash "$TEST_PROJECT_ROOT/scripts/doctor-server.sh" 2>&1)
set -e
assert_contains 'CLI launcher является небезопасным symlink' "$doctor_symlink_output" \
  'doctor обнаруживает небезопасный symlink launcher'
assert_success 'symlink doctor launcher восстанавливается для status' install_doctor_cli

set +e
status_output=$(env PATH="$MOCK_BIN:$PATH" TMPDIR="$doctor_root" MOCK_BUSY_PORTS=8090 \
  MOCK_UNIT_PATH="$doctor_root/family-tree.service" FAMILY_ARCHIVE_STATUS_TEST_MODE=1 \
  FAMILY_ARCHIVE_CLI_BIN_DIR="$doctor_root/cli-bin" \
  DEPLOYMENT_CONFIG="$doctor_root/deployment.env" \
  bash "$TEST_PROJECT_ROOT/scripts/status-server.sh" --no-logs 2>&1)
set -e
assert_contains 'CLI:                     installed' "$status_output" \
  'status показывает CLI installed'
assert_contains "CLI path:                $doctor_root/cli-bin/family-archive" "$status_output" \
  'status показывает путь главной CLI-команды'

printf 'Setup tests: %s passed, %s failed.\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
