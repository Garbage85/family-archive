#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
BOOTSTRAP="$PROJECT_ROOT/scripts/bootstrap.sh"
SUITE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/family-archive-bootstrap-tests.XXXXXX")
MOCK_BIN="$SUITE_ROOT/mock-bin"
MOCK_CHILD="$SUITE_ROOT/mock-child"
PASSED=0
FAILED=0
case_root=""

cleanup() {
  if [[ -n $SUITE_ROOT && $SUITE_ROOT == "${TMPDIR:-/tmp}"/family-archive-bootstrap-tests.* && -d $SUITE_ROOT ]]; then
    rm -rf -- "$SUITE_ROOT"
  fi
}
trap cleanup EXIT

pass() {
  PASSED=$((PASSED + 1))
  printf 'ok bootstrap %s - %s\n' "$PASSED" "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf 'not ok bootstrap %s - %s\n' "$((PASSED + FAILED))" "$1" >&2
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

assert_equal() {
  local expected=$1 actual=$2 name=$3
  if [[ $actual == "$expected" ]]; then pass "$name"; else fail "$name (ожидалось '$expected', получено '$actual')"; fi
}

mkdir -p "$MOCK_BIN"
# shellcheck disable=SC2016 # Переменные раскрываются при запуске mock git.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'printf "%s\n" "$*" >> "$BOOTSTRAP_GIT_RECORD"' \
  'destination=${!#}' \
  'mkdir -p "$destination/scripts"' \
  'for script in install-server.sh update-server.sh migrate-legacy-server.sh; do cp "$BOOTSTRAP_MOCK_CHILD" "$destination/scripts/$script"; chmod 0755 "$destination/scripts/$script"; done' \
  > "$MOCK_BIN/git"
printf '%s\n' '#!/usr/bin/env bash' 'exec "$@"' > "$MOCK_BIN/sudo"
# shellcheck disable=SC2016 # Переменные раскрываются при запуске mock child.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'name=${0##*/}' \
  'printf "%s\t%s\trepo=%s\tbranch=%s\n" "$name" "$*" "${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_URL:-}" "${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_BRANCH:-}" >> "$BOOTSTRAP_CHILD_RECORD"' \
  'if [[ ${BOOTSTRAP_FAIL_CHILD:-} == "$name" ]]; then exit "${BOOTSTRAP_FAIL_CODE:-1}"; fi' \
  'exit 0' > "$MOCK_CHILD"
chmod 0755 "$MOCK_BIN/git" "$MOCK_BIN/sudo" "$MOCK_CHILD"

new_case() {
  local destination_var=$1 name=$2 root
  root="$SUITE_ROOT/$name"
  mkdir -p "$root"
  chmod 0755 "$root"
  : > "$root/child-record"
  : > "$root/git-record"
  printf -v "$destination_var" '%s' "$root"
}

make_legacy() {
  local install_root=$1
  mkdir -p "$install_root/pb_data"
  chmod 0755 "$install_root"
  printf legacy > "$install_root/pocketbase"
  chmod 0755 "$install_root/pocketbase"
}

make_release() {
  local install_root=$1 release
  release="$install_root/releases/release-one"
  mkdir -p "$release/pb_public" "$release/pb_migrations" \
    "$install_root/shared/pb_data" "$install_root/app/repository.git" "$install_root/backups"
  chmod 0755 "$install_root"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$release/pocketbase"
  chmod 0755 "$release/pocketbase"
  printf 'COMMIT=test\n' > "$release/release.env"
  printf 'INSTALL_ROOT=%s\n' "$install_root" > "$install_root/shared/deployment.env"
  ln -s "$release" "$install_root/current"
}

run_bootstrap() {
  local root=$1
  shift
  env PATH="$MOCK_BIN:$PATH" TMPDIR="$root" \
    FAMILY_ARCHIVE_BOOTSTRAP_TEST_MODE=1 \
    FAMILY_ARCHIVE_BOOTSTRAP_INSTALL_ROOT="$root/install" \
    BOOTSTRAP_MOCK_CHILD="$MOCK_CHILD" \
    BOOTSTRAP_CHILD_RECORD="$root/child-record" \
    BOOTSTRAP_GIT_RECORD="$root/git-record" \
    BOOTSTRAP_FAIL_CHILD="${BOOTSTRAP_CASE_FAIL_CHILD:-}" \
    BOOTSTRAP_FAIL_CODE="${BOOTSTRAP_CASE_FAIL_CODE:-1}" \
    bash "$BOOTSTRAP" "$@"
}

recorded_modes() {
  cut -f1 "$1/child-record" | paste -sd ' ' -
}

checkout_is_clean() {
  [[ -z $(find "$1" -mindepth 1 -maxdepth 1 -type d -name 'family-archive-bootstrap.*' -print -quit) ]]
}

new_case case_root auto-install
assert_success 'чистая система автоматически выбирает install' run_bootstrap "$case_root"
assert_equal install-server.sh "$(recorded_modes "$case_root")" 'auto install запускает только installer'
assert_success 'checkout удаляется после успешной установки' checkout_is_clean "$case_root"

new_case case_root auto-update
make_release "$case_root/install"
assert_success 'release-layout автоматически выбирает update' run_bootstrap "$case_root"
assert_equal update-server.sh "$(recorded_modes "$case_root")" 'auto update запускает только updater'

new_case case_root auto-migrate
make_legacy "$case_root/install"
assert_success 'legacy-layout автоматически выбирает migrate с --yes' run_bootstrap "$case_root" --yes
assert_equal 'migrate-legacy-server.sh migrate-legacy-server.sh' "$(recorded_modes "$case_root")" \
  'legacy сначала запускает dry-run, затем реальную миграцию'
assert_success 'первый legacy-вызов содержит dry-run' grep -q $'^migrate-legacy-server.sh\t.*--dry-run' "$case_root/child-record"
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'реальный legacy-вызов получает yes' \
  bash -c 'tail -n 1 "$1/child-record" | grep -q -- "--yes"' _ "$case_root"

new_case case_root legacy-confirm-required
make_legacy "$case_root/install"
assert_failure 'legacy без TTY и --yes останавливается после dry-run' run_bootstrap "$case_root"
assert_equal migrate-legacy-server.sh "$(recorded_modes "$case_root")" \
  'без подтверждения выполнен только legacy dry-run'
assert_success 'checkout удаляется после отказа от legacy confirmation' checkout_is_clean "$case_root"

new_case case_root mixed-layout
make_release "$case_root/install"
printf legacy > "$case_root/install/pocketbase"
assert_failure 'смешанный layout отклоняется без запуска child' run_bootstrap "$case_root"
assert_equal '' "$(recorded_modes "$case_root")" 'mixed layout ничего не запускает'

new_case case_root current-file
mkdir -p "$case_root/install"
chmod 0755 "$case_root/install"
printf broken > "$case_root/install/current"
assert_failure 'current как обычный файл отклоняется' run_bootstrap "$case_root"
assert_equal '' "$(recorded_modes "$case_root")" 'current file не запускает child'

new_case case_root current-outside
mkdir -p "$case_root/install/releases" "$case_root/outside-release"
chmod 0755 "$case_root/install"
ln -s "$case_root/outside-release" "$case_root/install/current"
assert_failure 'current symlink вне install root отклоняется' run_bootstrap "$case_root"

new_case case_root damaged-release
mkdir -p "$case_root/install/releases/release-one" "$case_root/install/shared"
chmod 0755 "$case_root/install"
ln -s "$case_root/install/releases/release-one" "$case_root/install/current"
assert_failure 'повреждённый shared/release layout отклоняется' run_bootstrap "$case_root"

new_case case_root unsafe-mode
make_legacy "$case_root/install"
chmod 0775 "$case_root/install"
assert_failure 'group-writable install root отклоняется до child' run_bootstrap "$case_root" --yes
assert_equal '' "$(recorded_modes "$case_root")" 'небезопасные права ничего не запускают'

new_case case_root forced-install
assert_success '--install работает только на clean layout' run_bootstrap "$case_root" --install
assert_equal install-server.sh "$(recorded_modes "$case_root")" 'forced install выбрал installer'

new_case case_root forced-update
make_release "$case_root/install"
assert_success '--update работает только на release layout' run_bootstrap "$case_root" --update
assert_equal update-server.sh "$(recorded_modes "$case_root")" 'forced update выбрал updater'

new_case case_root forced-migrate
make_legacy "$case_root/install"
assert_success '--migrate работает только на legacy layout' run_bootstrap "$case_root" --migrate --yes
assert_equal 'migrate-legacy-server.sh migrate-legacy-server.sh' "$(recorded_modes "$case_root")" \
  'forced migrate сохранил dry-run gate'

new_case case_root wrong-forced-mode
make_release "$case_root/install"
assert_failure 'forced migrate не может ошибочно выбрать release-layout' run_bootstrap "$case_root" --migrate --yes
assert_equal '' "$(recorded_modes "$case_root")" 'несовместимый forced mode ничего не запускает'

new_case case_root conflicting-modes
assert_failure 'конфликт режимов отклоняется до clone' run_bootstrap "$case_root" --install --update
assert_equal '' "$(cat "$case_root/git-record")" 'конфликт режимов не клонирует репозиторий'

new_case case_root dry-run
make_release "$case_root/install"
assert_success '--dry-run передаётся выбранному updater' run_bootstrap "$case_root" --dry-run
assert_success 'updater получил dry-run' grep -q -- '--dry-run' "$case_root/child-record"

new_case case_root yes
make_release "$case_root/install"
assert_success '--yes передаётся поддерживающему updater' run_bootstrap "$case_root" --yes
assert_success 'updater получил yes' grep -q -- '--yes' "$case_root/child-record"

new_case case_root update-port-rejected
make_release "$case_root/install"
assert_failure '--port не меняет существующую release-установку молча' \
  run_bootstrap "$case_root" --port 8096
assert_equal '' "$(recorded_modes "$case_root")" 'ошибочный --port не запускает updater'

new_case case_root update-change-port
make_release "$case_root/install"
assert_success '--change-port передаётся только updater' \
  run_bootstrap "$case_root" --change-port 8096
assert_success 'updater получил осознанную смену порта' grep -q -- '--change-port 8096' "$case_root/child-record"

new_case case_root migrate-port-rejected
make_legacy "$case_root/install"
assert_failure 'legacy migration отклоняет --port и сохраняет unit' \
  run_bootstrap "$case_root" --yes --port 8096
assert_equal '' "$(recorded_modes "$case_root")" 'legacy --port не запускает migrator'

new_case case_root passthrough
assert_success 'параметры установки передаются отдельными аргументами без eval' \
  run_bootstrap "$case_root" --yes --port 8095 --site-name 'Архив семьи' --timezone Asia/Chita --no-systemd
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'child получил все разрешённые параметры установки' \
  bash -c 'line=$(cat "$1/child-record"); [[ $line == *"--port 8095"* && $line == *"--site-name Архив семьи"* && $line == *"--timezone Asia/Chita"* && $line == *"--no-systemd"* ]]' _ "$case_root"

new_case case_root repo-branch
assert_success 'repo и branch управляют clone и безопасным child env' \
  run_bootstrap "$case_root" --repo https://example.com/family.git --branch stable
# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'repo/branch не повторяются как child CLI options' \
  bash -c 'line=$(cat "$1/child-record"); [[ $line == *"repo=https://example.com/family.git"* && $line == *"branch=stable"* && $line != *"--repo"* && $line != *"--branch"* ]]' _ "$case_root"

new_case case_root child-error
BOOTSTRAP_CASE_FAIL_CHILD=install-server.sh BOOTSTRAP_CASE_FAIL_CODE=37
set +e
run_bootstrap "$case_root" >/dev/null 2>&1
status=$?
set -e
unset BOOTSTRAP_CASE_FAIL_CHILD BOOTSTRAP_CASE_FAIL_CODE
assert_equal 37 "$status" 'bootstrap возвращает точный ненулевой код child'
assert_success 'checkout удаляется после ошибки child' checkout_is_clean "$case_root"

new_case case_root detection-error-cleanup
mkdir -p "$case_root/install"
chmod 0755 "$case_root/install"
printf unknown > "$case_root/install/unknown-file"
assert_failure 'неизвестный layout диагностируется без child' run_bootstrap "$case_root"
assert_success 'checkout удаляется после ошибки определения layout' checkout_is_clean "$case_root"

# shellcheck disable=SC2016 # $1 раскрывается внутри отдельного bash -c.
assert_success 'все bootstrap cases использовали только test install roots' \
  bash -c '! grep -R "/opt/family-tree" "$1"/*/child-record >/dev/null 2>&1' _ "$SUITE_ROOT"

printf 'Bootstrap tests: %s passed, %s failed.\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
