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
  'if [[ ${1:-} == --git-dir=* && ${2:-} == rev-parse && ${3:-} == --is-bare-repository ]]; then exec /usr/bin/git "$@"; fi' \
  'printf "%s\n" "$*" >> "$BOOTSTRAP_GIT_RECORD"' \
  'destination=${!#}' \
  'mkdir -p "$destination/scripts"' \
  'for script in install-server.sh update-server.sh migrate-legacy-server.sh; do cp "$BOOTSTRAP_MOCK_CHILD" "$destination/scripts/$script"; chmod 0755 "$destination/scripts/$script"; done' \
  > "$MOCK_BIN/git"
printf '%s\n' '#!/usr/bin/env bash' 'exec "$@"' > "$MOCK_BIN/sudo"
# shellcheck disable=SC2016 # Аргументы раскрываются при запуске mock runuser.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'printf "%s\n" "$*" >> "$BOOTSTRAP_RUNUSER_RECORD"' \
  'operation=' \
  'while (($#)); do' \
  '  [[ $1 == -- ]] && { shift; break; }' \
  '  shift' \
  'done' \
  '[[ ${1:-} == test ]] && operation=${2:-}' \
  '[[ $operation != -r || ! -f $BOOTSTRAP_MOCK_CASE_ROOT/deny-pb-data-read ]] || exit 1' \
  '[[ $operation != -w || ! -f $BOOTSTRAP_MOCK_CASE_ROOT/deny-pb-data-write ]] || exit 1' \
  'exec "$@"' > "$MOCK_BIN/runuser"
# shellcheck disable=SC2016 # Переменные раскрываются при запуске mock systemctl.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'command=${1:-}' \
  'case "$command" in' \
  '  cat) cat "$BOOTSTRAP_MOCK_UNIT" ;;' \
  '  is-active) [[ $(cat "$BOOTSTRAP_MOCK_SERVICE_STATE") == active ]] ;;' \
  '  show)' \
  '    case "$*" in' \
  '      *--property=User*) sed -n "s/^[[:space:]]*User[[:space:]]*=[[:space:]]*//p" "$BOOTSTRAP_MOCK_UNIT" ;;' \
  '      *--property=Group*) sed -n "s/^[[:space:]]*Group[[:space:]]*=[[:space:]]*//p" "$BOOTSTRAP_MOCK_UNIT" ;;' \
  '      *--property=DynamicUser*) sed -n "s/^[[:space:]]*DynamicUser[[:space:]]*=[[:space:]]*//p" "$BOOTSTRAP_MOCK_UNIT" ;;' \
  '    esac ;;' \
  '  *) exit 1 ;;' \
  'esac' > "$MOCK_BIN/systemctl"
# shellcheck disable=SC2016 # familytree моделируется без изменения системного passwd.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'case "${1:-}:${2:-}" in' \
  '  passwd:familytree) printf "%s\n" "familytree:x:997:997::/nonexistent:/usr/sbin/nologin" ;;' \
  '  group:familytree) printf "%s\n" "familytree:x:997:" ;;' \
  '  passwd:missing-user|group:missing-group) exit 2 ;;' \
  '  *) exec /usr/bin/getent "$@" ;;' \
  'esac' > "$MOCK_BIN/getent"
# shellcheck disable=SC2016 # UID путей моделируются отдельно от реального владельца test sandbox.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'target=${!#}' \
  'rule=' \
  'if [[ ${1:-} == -c && ${2:-} == %u ]]; then' \
  '  if [[ $target == "$BOOTSTRAP_MOCK_INSTALL_ROOT" ]]; then rule=root-owner;' \
  '  elif [[ $target == "$BOOTSTRAP_MOCK_INSTALL_ROOT/pocketbase" ]]; then rule=pocketbase-owner;' \
  '  elif [[ $target == "$BOOTSTRAP_MOCK_INSTALL_ROOT/shared/pb_data" ]]; then rule=release-data-owner;' \
  '  elif [[ $target == "$BOOTSTRAP_MOCK_INSTALL_ROOT/pb_data" || $target == "$BOOTSTRAP_MOCK_INSTALL_ROOT/pb_data/"* ]]; then rule=pb-data-owner; fi' \
  'elif [[ ${1:-} == -c && ${2:-} == %g && $target == "$BOOTSTRAP_MOCK_INSTALL_ROOT/shared/pb_data" ]]; then' \
  '  rule=release-data-group' \
  'fi' \
  'if [[ -n $rule && -f $BOOTSTRAP_MOCK_CASE_ROOT/$rule ]]; then cat "$BOOTSTRAP_MOCK_CASE_ROOT/$rule"; exit 0; fi' \
  'exec /usr/bin/stat "$@"' > "$MOCK_BIN/stat"
# shellcheck disable=SC2016 # Переменные раскрываются при запуске mock child.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'name=${0##*/}' \
  'printf "%s\t%s\trepo=%s\tbranch=%s\n" "$name" "$*" "${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_URL:-}" "${FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_BRANCH:-}" >> "$BOOTSTRAP_CHILD_RECORD"' \
  'if [[ ${BOOTSTRAP_FAIL_CHILD:-} == "$name" ]]; then exit "${BOOTSTRAP_FAIL_CODE:-1}"; fi' \
  'exit 0' > "$MOCK_CHILD"
chmod 0755 "$MOCK_BIN/git" "$MOCK_BIN/sudo" "$MOCK_BIN/systemctl" \
  "$MOCK_BIN/getent" "$MOCK_BIN/stat" "$MOCK_BIN/runuser" "$MOCK_CHILD"

new_case() {
  local destination_var=$1 name=$2 root
  root="$SUITE_ROOT/$name"
  mkdir -p "$root"
  chmod 0755 "$root"
  : > "$root/child-record"
  : > "$root/git-record"
  : > "$root/runuser-record"
  printf -v "$destination_var" '%s' "$root"
}

make_legacy() {
  local install_root=$1
  mkdir -p "$install_root/pb_data"
  chmod 0755 "$install_root"
  printf legacy > "$install_root/pocketbase"
  chmod 0755 "$install_root/pocketbase"
  printf database > "$install_root/pb_data/data.db"
  printf 997 > "$(dirname "$install_root")/root-owner"
  printf 997 > "$(dirname "$install_root")/pocketbase-owner"
  printf 997 > "$(dirname "$install_root")/pb-data-owner"
  printf '%s\n' '[Service]' 'User=familytree' 'Group=familytree' \
    "ExecStart=$install_root/pocketbase serve --http=0.0.0.0:8090" \
    > "$(dirname "$install_root")/family-tree.service"
  printf active > "$(dirname "$install_root")/service-state"
}

make_release() {
  local install_root=$1 link_style=${2:-absolute} release
  release="$install_root/releases/release-one"
  mkdir -p "$release/pb_public" "$release/pb_migrations" \
    "$install_root/shared/pb_data" "$install_root/app"
  /usr/bin/git init --bare -q "$install_root/app/repository.git"
  chmod 0755 "$install_root"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$release/pocketbase"
  chmod 0755 "$release/pocketbase"
  printf 'INSTALL_ROOT=%s\nSERVICE_USER=%s\nSERVICE_GROUP=%s\n' \
    "$install_root" "$(id -un)" "$(id -gn)" \
    > "$install_root/shared/deployment.env"
  chmod 0600 "$install_root/shared/deployment.env"
  chmod 0750 "$install_root/shared/pb_data"
  ln -s "$install_root/shared/pb_data" "$release/pb_data"
  if [[ $link_style == relative ]]; then
    ln -s releases/release-one "$install_root/current"
  else
    ln -s "$release" "$install_root/current"
  fi
}

run_bootstrap() {
  local root=$1 expected_uid expected_gid
  shift
  expected_uid=$(cat "$root/expected-owner-uid" 2>/dev/null || id -u)
  expected_gid=$(cat "$root/expected-owner-gid" 2>/dev/null || id -g)
  env PATH="$MOCK_BIN:$PATH" TMPDIR="$root" \
    FAMILY_ARCHIVE_BOOTSTRAP_TEST_MODE=1 \
    FAMILY_ARCHIVE_BOOTSTRAP_INSTALL_ROOT="$root/install" \
    FAMILY_ARCHIVE_BOOTSTRAP_EXPECTED_OWNER_UID="$expected_uid" \
    FAMILY_ARCHIVE_BOOTSTRAP_EXPECTED_OWNER_GID="$expected_gid" \
    FAMILY_ARCHIVE_BOOTSTRAP_TEST_UID_MIN=1000 \
    BOOTSTRAP_MOCK_CASE_ROOT="$root" \
    BOOTSTRAP_MOCK_INSTALL_ROOT="$root/install" \
    BOOTSTRAP_MOCK_UNIT="$root/family-tree.service" \
    BOOTSTRAP_MOCK_SERVICE_STATE="$root/service-state" \
    BOOTSTRAP_MOCK_CHILD="$MOCK_CHILD" \
    BOOTSTRAP_CHILD_RECORD="$root/child-record" \
    BOOTSTRAP_GIT_RECORD="$root/git-record" \
    BOOTSTRAP_RUNUSER_RECORD="$root/runuser-record" \
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
# shellcheck disable=SC2016 # Positional parameter belongs to child bash.
assert_success 'release-layout не требует корневые pocketbase и pb_data' \
  bash -c '[[ ! -e $1/install/pocketbase && ! -e $1/install/pb_data ]]' _ "$case_root"
assert_equal 750 "$(stat -c '%a' "$case_root/install/shared/pb_data")" \
  'release-layout принимает service-owned shared/pb_data mode 0750'
assert_success 'release validation проверяет чтение shared/pb_data от SERVICE_USER' \
  grep -Fq -- "-u $(id -un) -- test -r $case_root/install/shared/pb_data" "$case_root/runuser-record"
assert_success 'release validation проверяет запись shared/pb_data от SERVICE_USER' \
  grep -Fq -- "-u $(id -un) -- test -w $case_root/install/shared/pb_data" "$case_root/runuser-record"

new_case case_root release-data-owner
make_release "$case_root/install"
printf 4242 > "$case_root/release-data-owner"
assert_failure 'shared/pb_data с владельцем не SERVICE_USER отклоняется' run_bootstrap "$case_root"

new_case case_root release-data-group
make_release "$case_root/install"
printf 4242 > "$case_root/release-data-group"
assert_failure 'shared/pb_data с группой не SERVICE_GROUP отклоняется' run_bootstrap "$case_root"

new_case case_root release-data-world-write
make_release "$case_root/install"
chmod 0752 "$case_root/install/shared/pb_data"
assert_failure 'world-writable shared/pb_data отклоняется' run_bootstrap "$case_root"

new_case case_root release-data-symlink
make_release "$case_root/install"
mkdir "$case_root/outside-data"
rm -rf -- "$case_root/install/shared/pb_data"
ln -s "$case_root/outside-data" "$case_root/install/shared/pb_data"
assert_failure 'shared/pb_data symlink отклоняется отдельно от test -d' run_bootstrap "$case_root"

new_case case_root release-data-no-read
make_release "$case_root/install"
touch "$case_root/deny-pb-data-read"
assert_failure 'release отклоняется, если SERVICE_USER не может читать pb_data' run_bootstrap "$case_root"

new_case case_root release-data-no-write
make_release "$case_root/install"
touch "$case_root/deny-pb-data-write"
assert_failure 'release отклоняется, если SERVICE_USER не может писать в pb_data' run_bootstrap "$case_root"

new_case case_root relative-current
make_release "$case_root/install" relative
assert_success 'relative current symlink внутри releases выбирает update' run_bootstrap "$case_root"
assert_equal update-server.sh "$(recorded_modes "$case_root")" 'relative current запускает updater'

new_case case_root auto-migrate
make_legacy "$case_root/install"
assert_success 'legacy-root принадлежит familytree из active unit и разрешён' run_bootstrap "$case_root" --yes
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

new_case case_root mixed-legacy-partial-release
make_legacy "$case_root/install"
mkdir "$case_root/install/app"
assert_failure 'legacy с частичным release app определяется как mixed-layout' \
  run_bootstrap "$case_root" --yes
assert_equal '' "$(recorded_modes "$case_root")" 'частичный mixed-layout ничего не запускает'

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

new_case case_root missing-current-target
make_release "$case_root/install"
rm -rf -- "$case_root/install/releases/release-one"
assert_failure 'отсутствующий current target отклоняется' run_bootstrap "$case_root"

new_case case_root missing-release-pocketbase
make_release "$case_root/install"
rm -f -- "$case_root/install/releases/release-one/pocketbase"
assert_failure 'отсутствующий current/pocketbase отклоняется' run_bootstrap "$case_root"

new_case case_root missing-shared-data
make_release "$case_root/install"
rmdir "$case_root/install/shared/pb_data"
assert_failure 'отсутствующий shared/pb_data отклоняется' run_bootstrap "$case_root"

new_case case_root missing-deployment-env
make_release "$case_root/install"
rm -f -- "$case_root/install/shared/deployment.env"
assert_failure 'отсутствующий shared/deployment.env отклоняется' run_bootstrap "$case_root"

new_case case_root missing-repository
make_release "$case_root/install"
rm -rf -- "$case_root/install/app/repository.git"
assert_failure 'отсутствующий app/repository.git отклоняется' run_bootstrap "$case_root"

new_case case_root non-bare-repository
make_release "$case_root/install"
rm -rf -- "$case_root/install/app/repository.git"
mkdir "$case_root/install/app/repository.git"
assert_failure 'обычный каталог вместо bare repository отклоняется' run_bootstrap "$case_root"

new_case case_root unsafe-release-symlink
make_release "$case_root/install"
ln -s /etc/passwd "$case_root/install/releases/release-one/pb_public/outside"
assert_failure 'release symlink с target вне release отклоняется' run_bootstrap "$case_root"

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

new_case case_root legacy-root-owned
make_legacy "$case_root/install"
printf 0 > "$case_root/root-owner"
assert_success 'legacy-root с владельцем root разрешён при service-owned pb_data' \
  run_bootstrap "$case_root" --dry-run

new_case case_root foreign-legacy-owner
make_legacy "$case_root/install"
printf 4242 > "$case_root/root-owner"
assert_failure 'legacy-root с посторонним uid отклоняется' run_bootstrap "$case_root" --dry-run
assert_equal '' "$(recorded_modes "$case_root")" 'посторонний legacy owner не запускает child'

new_case case_root missing-unit-user
make_legacy "$case_root/install"
sed -i 's/User=familytree/User=missing-user/' "$case_root/family-tree.service"
assert_failure 'отсутствующий User из unit отклоняется' run_bootstrap "$case_root" --dry-run

new_case case_root empty-unit-user
make_legacy "$case_root/install"
sed -i 's/User=familytree/User=/' "$case_root/family-tree.service"
assert_failure 'пустой User в legacy unit отклоняется' run_bootstrap "$case_root" --dry-run

new_case case_root foreign-pb-data-owner
make_legacy "$case_root/install"
printf 4242 > "$case_root/pb-data-owner"
assert_failure 'pb_data с посторонним владельцем отклоняется' run_bootstrap "$case_root" --dry-run

new_case case_root dynamic-unit-user
make_legacy "$case_root/install"
sed -i '/Group=familytree/a DynamicUser=yes' "$case_root/family-tree.service"
assert_failure 'DynamicUser в legacy unit отклоняется' run_bootstrap "$case_root" --dry-run

new_case case_root symlink-legacy-root
make_legacy "$case_root/real-install"
ln -s "$case_root/real-install" "$case_root/install"
assert_failure 'symlink вместо legacy-root отклоняется' run_bootstrap "$case_root" --dry-run

new_case case_root non-root-release
make_release "$case_root/install"
printf 0 > "$case_root/expected-owner-uid"
printf 0 > "$case_root/expected-owner-gid"
assert_failure 'release-layout с не-root владельцем отклоняется' run_bootstrap "$case_root" --dry-run

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
