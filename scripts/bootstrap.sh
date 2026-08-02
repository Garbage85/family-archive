#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEFAULT_REPOSITORY_URL=https://github.com/Garbage85/family-archive.git
readonly DEFAULT_REPOSITORY_BRANCH=main

usage() {
  cat <<'EOF'
Единый bootstrap Family Archive: install, update или legacy migration.

Использование:
  bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) [опции]

Опции:
  --repo URL       Репозиторий bootstrap-кода (по умолчанию официальный)
  --branch NAME    Ветка bootstrap-кода (по умолчанию main)
  --install        Принудительно выбрать чистую установку
  --update         Принудительно выбрать release-обновление
  --migrate        Принудительно выбрать legacy-миграцию
  --dry-run        Передать безопасный dry-run выбранному скрипту
  --yes            Разрешить неинтерактивный запуск и передать подтверждение
  --port PORT      Порт новой установки (1024–65535)
  --change-port PORT Осознанно сменить порт release-установки
  --site-name NAME Имя сайта новой установки
  --timezone ZONE  Часовой пояс приложения новой установки
  --no-systemd     Не создавать systemd unit при новой установке
  -h, --help       Показать справку

Без явного режима действие определяется только по проверенному layout. Допустимые
child-опции передаются выбранному штатному скрипту как отдельные аргументы, без eval.
EOF
}

die() {
  printf 'ОШИБКА: %s\n' "$*" >&2
  exit 1
}

REPOSITORY_URL=$DEFAULT_REPOSITORY_URL
REPOSITORY_BRANCH=$DEFAULT_REPOSITORY_BRANCH
FORCED_MODE=""
MODE_COUNT=0
DRY_RUN=0
ASSUME_YES=0
REPOSITORY_URL_EXPLICIT=0
REPOSITORY_BRANCH_EXPLICIT=0
BOOTSTRAP_DIR=""
DETECTED_MODE=""
DETECTION_REASON=""
TEST_MODE=${FAMILY_ARCHIVE_BOOTSTRAP_TEST_MODE:-0}
INSTALL_ROOT=/opt/family-tree
EXPECTED_OWNER_UID=0
declare -a CHILD_ARGS=()
PORT_VALUE=""
CHANGE_PORT_VALUE=""
SITE_NAME_VALUE=""
TIMEZONE_VALUE=""
NO_SYSTEMD=0

cleanup() {
  if [[ -n $BOOTSTRAP_DIR && -d $BOOTSTRAP_DIR ]]; then
    rm -rf -- "$BOOTSTRAP_DIR"
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

set_forced_mode() {
  FORCED_MODE=$1
  MODE_COUNT=$((MODE_COUNT + 1))
}

while (($#)); do
  case "$1" in
    --repo) [[ $# -ge 2 ]] || die "Для --repo требуется URL."; REPOSITORY_URL=$2; REPOSITORY_URL_EXPLICIT=1; shift 2 ;;
    --repo=*) REPOSITORY_URL=${1#*=}; REPOSITORY_URL_EXPLICIT=1; shift ;;
    --branch) [[ $# -ge 2 ]] || die "Для --branch требуется имя."; REPOSITORY_BRANCH=$2; REPOSITORY_BRANCH_EXPLICIT=1; shift 2 ;;
    --branch=*) REPOSITORY_BRANCH=${1#*=}; REPOSITORY_BRANCH_EXPLICIT=1; shift ;;
    --install) set_forced_mode install; shift ;;
    --update) set_forced_mode update; shift ;;
    --migrate) set_forced_mode migrate; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --port) [[ $# -ge 2 ]] || die "Для --port требуется значение."; PORT_VALUE=$2; shift 2 ;;
    --port=*) PORT_VALUE=${1#*=}; shift ;;
    --change-port) [[ $# -ge 2 ]] || die "Для --change-port требуется значение."; CHANGE_PORT_VALUE=$2; shift 2 ;;
    --change-port=*) CHANGE_PORT_VALUE=${1#*=}; shift ;;
    --site-name) [[ $# -ge 2 ]] || die "Для --site-name требуется значение."; SITE_NAME_VALUE=$2; shift 2 ;;
    --site-name=*) SITE_NAME_VALUE=${1#*=}; shift ;;
    --timezone) [[ $# -ge 2 ]] || die "Для --timezone требуется значение."; TIMEZONE_VALUE=$2; shift 2 ;;
    --timezone=*) TIMEZONE_VALUE=${1#*=}; shift ;;
    --no-systemd) NO_SYSTEMD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; (($# == 0)) || die "Произвольные child-опции bootstrap не поддерживаются." ;;
    *) die "Неизвестная опция bootstrap: $1" ;;
  esac
done

(( MODE_COUNT <= 1 )) || die "Опции --install, --update и --migrate конфликтуют."
[[ $REPOSITORY_URL =~ ^https://[A-Za-z0-9._~:/@%+=,-]+$ ]] ||
  die "--repo должен быть безопасным HTTPS URL."
[[ -n $REPOSITORY_BRANCH && $REPOSITORY_BRANCH != -* &&
  $REPOSITORY_BRANCH != *[[:space:]]* && $REPOSITORY_BRANCH != *..* &&
  $REPOSITORY_BRANCH != *@\{* ]] || die "Некорректный --branch."

case "$TEST_MODE" in
  0) ;;
  1)
    INSTALL_ROOT=${FAMILY_ARCHIVE_BOOTSTRAP_INSTALL_ROOT:-}
    [[ -n $INSTALL_ROOT ]] || die "В bootstrap test mode требуется FAMILY_ARCHIVE_BOOTSTRAP_INSTALL_ROOT."
    EXPECTED_OWNER_UID=$(id -u)
    ;;
  *) die "FAMILY_ARCHIVE_BOOTSTRAP_TEST_MODE допускает только 0 или 1." ;;
esac

validate_absolute_install_root() {
  local component partial="" normalized sandbox
  [[ $INSTALL_ROOT =~ ^/[A-Za-z0-9._/-]+$ && $INSTALL_ROOT != */ && $INSTALL_ROOT != *//* ]] ||
    die "Install root должен быть абсолютным нормализованным путём без пробелов."
  [[ $INSTALL_ROOT != / && $INSTALL_ROOT != /opt && $INSTALL_ROOT != /home ]] ||
    die "Опасный install root запрещён: $INSTALL_ROOT"
  [[ ! $INSTALL_ROOT =~ (^|/)\.\.?(/|$) ]] || die "Install root содержит '.' или '..'."
  normalized=$(realpath -m -- "$INSTALL_ROOT")
  [[ $normalized == "$INSTALL_ROOT" ]] || die "Install root не нормализован: $INSTALL_ROOT"
  IFS='/' read -r -a components <<< "${INSTALL_ROOT#/}"
  for component in "${components[@]}"; do
    partial="$partial/$component"
    [[ ! -L $partial ]] || die "Install root проходит через опасный symlink: $partial"
  done
  if (( TEST_MODE )); then
    sandbox=$(realpath -m -- "${TMPDIR:-/tmp}")
    [[ $INSTALL_ROOT == "$sandbox"/* ]] || die "Test install root должен находиться внутри TMPDIR."
  fi
}

check_owner_and_mode() {
  local path=$1 owner mode permissions
  if [[ ! -d $path || -L $path ]]; then
    DETECTION_REASON="install root не является обычным каталогом: $path"
    return 1
  fi
  owner=$(stat -c '%u' "$path")
  mode=$(stat -c '%a' "$path")
  if [[ ! $mode =~ ^[0-7]{3,4}$ ]]; then
    DETECTION_REASON="не удалось проверить права install root: $path"
    return 1
  fi
  permissions=$((8#$mode))
  if (( owner != EXPECTED_OWNER_UID )); then
    DETECTION_REASON="небезопасный владелец $path: uid=$owner, ожидается $EXPECTED_OWNER_UID"
    return 1
  fi
  if (( (permissions & 0022) != 0 )); then
    DETECTION_REASON="install root доступен на запись группе или остальным: $path (mode $mode)"
    return 1
  fi
}

regular_directory() {
  [[ -d $1 && ! -L $1 ]]
}

set_detection_error() {
  DETECTED_MODE=error
  DETECTION_REASON=$1
}

detect_installation() {
  local current="$INSTALL_ROOT/current" current_target=""
  local has_legacy=0 has_release=0

  if [[ ! -e $INSTALL_ROOT && ! -L $INSTALL_ROOT ]]; then
    DETECTED_MODE=install
    DETECTION_REASON='install root отсутствует'
    return
  fi
  [[ ! -L $INSTALL_ROOT ]] || { set_detection_error 'install root является symlink'; return; }
  if ! check_owner_and_mode "$INSTALL_ROOT"; then
    set_detection_error "$DETECTION_REASON"
    return
  fi

  [[ -e $INSTALL_ROOT/pocketbase || -L $INSTALL_ROOT/pocketbase ||
    -e $INSTALL_ROOT/pb_data || -L $INSTALL_ROOT/pb_data ]] && has_legacy=1
  [[ -e $current || -L $current || -e $INSTALL_ROOT/releases || -L $INSTALL_ROOT/releases ||
    -e $INSTALL_ROOT/shared || -L $INSTALL_ROOT/shared ]] && has_release=1

  if (( has_legacy && has_release )); then
    set_detection_error 'одновременно присутствуют legacy- и release-маркеры'
    return
  fi
  if [[ -e $current && ! -L $current ]]; then
    set_detection_error 'current существует, но не является symlink'
    return
  fi
  if [[ -L $current ]]; then
    current_target=$(readlink -f -- "$current" 2>/dev/null || true)
    if [[ -z $current_target || $current_target != "$INSTALL_ROOT/releases/"* ||
      $(dirname "$current_target") != "$INSTALL_ROOT/releases" ]]; then
      set_detection_error "current указывает вне install root или является dangling symlink: ${current_target:-не разрешён}"
      return
    fi
    if ! regular_directory "$INSTALL_ROOT/releases" ||
      ! regular_directory "$INSTALL_ROOT/shared" ||
      ! regular_directory "$INSTALL_ROOT/shared/pb_data" ||
      ! regular_directory "$INSTALL_ROOT/app" ||
      ! regular_directory "$INSTALL_ROOT/app/repository.git" ||
      ! regular_directory "$INSTALL_ROOT/backups" ||
      ! regular_directory "$current_target" ||
      [[ ! -f $current_target/pocketbase || -L $current_target/pocketbase || ! -x $current_target/pocketbase ]] ||
      ! regular_directory "$current_target/pb_public" ||
      ! regular_directory "$current_target/pb_migrations" ||
      [[ ! -f $current_target/release.env || -L $current_target/release.env ]] ||
      [[ ! -f $INSTALL_ROOT/shared/deployment.env || -L $INSTALL_ROOT/shared/deployment.env ]]; then
      set_detection_error 'release-layout неполон или содержит небезопасный тип пути'
      return
    fi
    DETECTED_MODE=update
    DETECTION_REASON="current -> $current_target"
    return
  fi
  if (( has_legacy )); then
    if [[ -f $INSTALL_ROOT/pocketbase && ! -L $INSTALL_ROOT/pocketbase && -x $INSTALL_ROOT/pocketbase &&
      -d $INSTALL_ROOT/pb_data && ! -L $INSTALL_ROOT/pb_data ]]; then
      DETECTED_MODE=migrate
      DETECTION_REASON='найдены обычные pocketbase и pb_data, current отсутствует'
    else
      set_detection_error 'legacy-маркеры неполны или имеют небезопасный тип'
    fi
    return
  fi
  if [[ -z $(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null) ]]; then
    DETECTED_MODE=install
    DETECTION_REASON='install root существует и пуст'
    return
  fi
  set_detection_error 'неизвестные файлы не соответствуют clean, release или legacy layout'
}

print_diagnostics() {
  local current_value=absent
  [[ -L $INSTALL_ROOT/current ]] && current_value="symlink -> $(readlink "$INSTALL_ROOT/current" 2>/dev/null || printf unreadable)"
  [[ -e $INSTALL_ROOT/current && ! -L $INSTALL_ROOT/current ]] && current_value="обычный файл/каталог"
  printf 'Диагностика bootstrap:\n' >&2
  printf '  install-root: %s\n  current: %s\n' "$INSTALL_ROOT" "$current_value" >&2
  printf '  pocketbase: %s\n  pb_data: %s\n  releases: %s\n  shared: %s\n' \
    "$([[ -e $INSTALL_ROOT/pocketbase || -L $INSTALL_ROOT/pocketbase ]] && printf present || printf absent)" \
    "$([[ -e $INSTALL_ROOT/pb_data || -L $INSTALL_ROOT/pb_data ]] && printf present || printf absent)" \
    "$([[ -e $INSTALL_ROOT/releases || -L $INSTALL_ROOT/releases ]] && printf present || printf absent)" \
    "$([[ -e $INSTALL_ROOT/shared || -L $INSTALL_ROOT/shared ]] && printf present || printf absent)" >&2
  printf '  причина отказа: %s\n' "$DETECTION_REASON" >&2
  printf 'Ничего не изменено. Для release-установки запустите family-archive doctor;\n' >&2
  printf 'иначе вручную проверьте владельца, права и содержимое %s.\n' "$INSTALL_ROOT" >&2
}

invoke_child() {
  local script=$1 child_repo="" child_branch=""
  shift
  [[ -x $script ]] || die "Штатный скрипт отсутствует или не executable: $script"
  (( REPOSITORY_URL_EXPLICIT )) && child_repo=$REPOSITORY_URL
  (( REPOSITORY_BRANCH_EXPLICIT )) && child_branch=$REPOSITORY_BRANCH
  sudo -- env \
    FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_URL="$child_repo" \
    FAMILY_ARCHIVE_BOOTSTRAP_REPOSITORY_BRANCH="$child_branch" \
    FAMILY_ARCHIVE_BOOTSTRAP_SELECTED_INSTALL_ROOT="$INSTALL_ROOT" \
    "$script" "$@"
}

validate_child_args() {
  local mode=$1
  CHILD_ARGS=()
  case "$mode" in
    install)
      [[ -z $CHANGE_PORT_VALUE ]] || die "--change-port применим только к release-обновлению."
      [[ -z $PORT_VALUE ]] || CHILD_ARGS+=(--port "$PORT_VALUE")
      [[ -z $SITE_NAME_VALUE ]] || CHILD_ARGS+=(--site-name "$SITE_NAME_VALUE")
      [[ -z $TIMEZONE_VALUE ]] || CHILD_ARGS+=(--timezone "$TIMEZONE_VALUE")
      (( NO_SYSTEMD )) && CHILD_ARGS+=(--no-systemd)
      ;;
    update)
      [[ -z $PORT_VALUE ]] || die "Для смены порта существующей установки используйте --change-port PORT."
      [[ -z $SITE_NAME_VALUE && -z $TIMEZONE_VALUE && $NO_SYSTEMD == 0 ]] ||
        die "--site-name, --timezone и --no-systemd применимы только к чистой установке."
      [[ -z $CHANGE_PORT_VALUE ]] || CHILD_ARGS+=(--change-port "$CHANGE_PORT_VALUE")
      ;;
    migrate)
      [[ -z $PORT_VALUE && -z $CHANGE_PORT_VALUE ]] ||
        die "Legacy migration сохраняет порт из unit; --port/--change-port здесь не применяются."
      [[ -z $SITE_NAME_VALUE && -z $TIMEZONE_VALUE && $NO_SYSTEMD == 0 ]] ||
        die "Параметры мастера применимы только к чистой установке."
      ;;
  esac
  return 0
}

run_or_exit() {
  local status
  if invoke_child "$@"; then
    return 0
  else
    status=$?
    exit "$status"
  fi
}

confirm_migration() {
  local answer
  (( ASSUME_YES )) && return 0
  [[ -t 0 ]] || die "Legacy dry-run завершён. Для неинтерактивной миграции повторите с --yes."
  read -r -p "Dry-run завершён. Начать реальную legacy-миграцию? [y/N] " answer
  [[ $answer == y || $answer == Y ]] || die "Legacy-миграция отменена; изменений после dry-run нет."
}

[[ $(uname -s) == Linux ]] || die "Bootstrap поддерживает только Linux."
[[ -n ${BASH_VERSION:-} ]] || die "Bootstrap необходимо запускать через bash."
(( BASH_VERSINFO[0] >= 4 )) || die "Нужен Bash 4 или новее; установлен $BASH_VERSION."
for required_command in curl git sudo realpath stat find readlink dirname env mktemp rm; do
  command -v "$required_command" >/dev/null 2>&1 || die "Не найдена обязательная команда: $required_command"
done
validate_absolute_install_root

BOOTSTRAP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/family-archive-bootstrap.XXXXXX")
printf 'Клонирую Family Archive во временный каталог.\n' >&2
git clone --depth 1 --branch "$REPOSITORY_BRANCH" "$REPOSITORY_URL" \
  "$BOOTSTRAP_DIR/repository"

detect_installation
if [[ $DETECTED_MODE == error ]]; then
  print_diagnostics
  exit 2
fi
if [[ -n $FORCED_MODE && $FORCED_MODE != "$DETECTED_MODE" ]]; then
  DETECTION_REASON="принудительный режим '$FORCED_MODE' не соответствует обнаруженному '$DETECTED_MODE': $DETECTION_REASON"
  print_diagnostics
  exit 2
fi
SELECTED_MODE=${FORCED_MODE:-$DETECTED_MODE}
validate_child_args "$SELECTED_MODE"

case "$SELECTED_MODE" in
  install)
    printf 'Обнаружена чистая система.\nДействие: установка.\n' >&2
    selected_script="$BOOTSTRAP_DIR/repository/scripts/install-server.sh"
    selected_args=("${CHILD_ARGS[@]}")
    (( DRY_RUN )) && selected_args+=(--dry-run)
    (( ASSUME_YES )) && selected_args+=(--yes)
    run_or_exit "$selected_script" "${selected_args[@]}"
    ;;
  update)
    printf 'Обнаружена release-установка.\nДействие: обновление.\n' >&2
    selected_script="$BOOTSTRAP_DIR/repository/scripts/update-server.sh"
    selected_args=("${CHILD_ARGS[@]}")
    (( DRY_RUN )) && selected_args+=(--dry-run)
    (( ASSUME_YES )) && selected_args+=(--yes)
    run_or_exit "$selected_script" "${selected_args[@]}"
    ;;
  migrate)
    printf 'Обнаружена legacy-установка.\nДействие: миграция.\n' >&2
    selected_script="$BOOTSTRAP_DIR/repository/scripts/migrate-legacy-server.sh"
    selected_args=(--legacy-root "$INSTALL_ROOT" --install-root "$INSTALL_ROOT" "${CHILD_ARGS[@]}")
    run_or_exit "$selected_script" "${selected_args[@]}" --dry-run
    (( DRY_RUN )) && exit 0
    confirm_migration
    selected_args+=(--yes)
    run_or_exit "$selected_script" "${selected_args[@]}"
    ;;
  *) die "Внутренняя ошибка выбора режима: $SELECTED_MODE" ;;
esac
