#!/usr/bin/env bash

if [[ -n ${FAMILY_ARCHIVE_COMMON_LOADED:-} ]]; then
  return 0
fi
readonly FAMILY_ARCHIVE_COMMON_LOADED=1
readonly FAMILY_ARCHIVE_MAIN_BASHPID=$BASHPID

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034 # Используется скриптами и тестами, подключающими common.sh.
PROJECT_ROOT="$(cd "$COMMON_DIR/../.." && pwd)"
CONFIG_FILE=""
CONFIG_FILE_EXPLICIT=0
QUIET=0
ROLLBACK_HANDLER=""
IN_ERROR_HANDLER=0
TRAPS_SETUP=0
# shellcheck disable=SC2034 # Результат restore читается вызывающим скриптом.
RESTORED_PREVIOUS_DATA=""
declare -a TEMP_DIRS=()
declare -a CLI_CREATED_PATHS=()

readonly -a DEPLOYMENT_CONFIG_KEYS=(
  APP_NAME
  SITE_NAME
  INSTALL_ROOT
  SERVICE_USER
  SERVICE_GROUP
  SERVICE_NAME
  LISTEN_HOST
  PORT
  TIMEZONE
  ENABLE_SYSTEMD
  LISTEN_ADDRESS
  REPOSITORY_URL
  DEFAULT_BRANCH
  POCKETBASE_VERSION
  POCKETBASE_SHA256_LINUX_ARM64
  POCKETBASE_SHA256_LINUX_AMD64
  POCKETBASE_SHA256_LINUX_ARMV7
  KEEP_RELEASES
  KEEP_BACKUPS
  MIN_FREE_MB
  HEALTH_RETRIES
  HEALTH_DELAY_SECONDS
)

log() {
  (( QUIET )) || printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2
}

warn() {
  printf 'ПРЕДУПРЕЖДЕНИЕ: %s\n' "$*" >&2
}

die() {
  printf 'ОШИБКА: %s\n' "$*" >&2
  run_rollback_handler 1
  exit 1
}

run_rollback_handler() {
  local exit_code=${1:-1} handler
  (( BASHPID == FAMILY_ARCHIVE_MAIN_BASHPID )) || return 0
  (( IN_ERROR_HANDLER == 0 )) || return 0
  handler=$ROLLBACK_HANDLER
  [[ -n $handler ]] && declare -F "$handler" >/dev/null || return 0
  ROLLBACK_HANDLER=""
  IN_ERROR_HANDLER=1
  "$handler" "$exit_code" || true
  IN_ERROR_HANDLER=0
}

cleanup_temp_dirs() {
  local path
  for path in "${TEMP_DIRS[@]:-}"; do
    if [[ -n $path && -d $path ]]; then
      rm -rf -- "$path" || true
    fi
  done
  TEMP_DIRS=()
}

remove_temp_dir() {
  local target=$1 path
  local -a remaining=()
  [[ -n $target ]] || return 0
  if [[ -d $target ]]; then
    rm -rf -- "$target" || die "Не удалось удалить временный каталог: $target"
  fi
  for path in "${TEMP_DIRS[@]:-}"; do
    [[ $path == "$target" ]] || remaining+=("$path")
  done
  TEMP_DIRS=("${remaining[@]}")
}

common_error_trap() {
  local exit_code=$1 line=$2 command=$3
  trap - ERR
  printf 'ОШИБКА: команда завершилась с кодом %s (строка %s): %s\n' \
    "$exit_code" "$line" "$command" >&2
  run_rollback_handler "$exit_code"
  exit "$exit_code"
}

common_signal_trap() {
  local exit_code=$1 signal=$2
  trap - INT TERM
  warn "Получен сигнал $signal; выполняю безопасное восстановление."
  run_rollback_handler "$exit_code"
  exit "$exit_code"
}

setup_traps() {
  (( TRAPS_SETUP == 0 )) || return 0
  # shellcheck disable=SC2016 # Переменные должны раскрываться только при срабатывании trap.
  append_trap 'common_error_trap "$?" "$LINENO" "$BASH_COMMAND"' ERR
  append_trap cleanup_temp_dirs EXIT
  append_trap 'common_signal_trap 130 INT' INT
  append_trap 'common_signal_trap 143 TERM' TERM
  TRAPS_SETUP=1
}

append_trap() {
  local command=$1 signal=$2 current previous
  current="$(trap -p "$signal")"
  if [[ -z $current ]]; then
    # shellcheck disable=SC2064 # command уже содержит отложенную строку обработчика.
    trap "$command" "$signal"
    return
  fi
  previous=${current#trap -- \'}
  previous=${previous%\' "$signal"}
  trap "$previous"$'\n'"$command" "$signal"
}

exit_if_help_requested() {
  local usage_function=$1 argument
  shift
  for argument in "$@"; do
    if [[ $argument == -h || $argument == --help ]]; then
      "$usage_function"
      exit 0
    fi
  done
}

make_temp_dir() {
  local destination_var=$1 template=${2:-family-archive.XXXXXX} created
  if [[ $template == /* ]]; then
    created="$(mktemp -d "$template")" || die "Не удалось создать временный каталог по шаблону: $template"
  else
    created="$(mktemp -d "${TMPDIR:-/tmp}/${template}")" ||
      die "Не удалось создать временный каталог по шаблону: ${TMPDIR:-/tmp}/${template}"
  fi
  TEMP_DIRS+=("$created")
  printf -v "$destination_var" '%s' "$created"
}

preparse_config() {
  local previous="" argument
  for argument in "$@"; do
    if [[ $previous == --config ]]; then
      CONFIG_FILE=$argument
      CONFIG_FILE_EXPLICIT=1
      previous=""
      continue
    fi
    case "$argument" in
      --config) previous=--config ;;
      --config=*) CONFIG_FILE=${argument#*=}; CONFIG_FILE_EXPLICIT=1 ;;
    esac
  done
  [[ -z $previous ]] || die "Для --config требуется путь к файлу."
}

load_config() {
  set_default_config

  if [[ -z $CONFIG_FILE ]]; then
    CONFIG_FILE=${DEPLOYMENT_CONFIG:-/etc/family-tree/deployment.env}
  fi
  if [[ -f $CONFIG_FILE ]]; then
    validate_config_file_security "$CONFIG_FILE"
    parse_deployment_config "$CONFIG_FILE"
  elif (( CONFIG_FILE_EXPLICIT )) || [[ -n ${DEPLOYMENT_CONFIG:-} ]]; then
    die "Указанный конфигурационный файл не найден: $CONFIG_FILE"
  elif [[ -f ${INSTALL_ROOT}/shared/deployment.env ]]; then
    CONFIG_FILE="${INSTALL_ROOT}/shared/deployment.env"
    validate_config_file_security "$CONFIG_FILE"
    parse_deployment_config "$CONFIG_FILE"
  else
    CONFIG_FILE=""
  fi
  validate_config
}

set_default_config() {
  APP_NAME=family-tree
  SITE_NAME='Family Archive'
  INSTALL_ROOT=/opt/family-tree
  SERVICE_USER=familytree
  SERVICE_GROUP=familytree
  SERVICE_NAME=family-tree
  LISTEN_HOST=0.0.0.0
  PORT=8090
  TIMEZONE="$(system_timezone)"
  ENABLE_SYSTEMD=true
  LISTEN_ADDRESS=""
  REPOSITORY_URL=https://github.com/Garbage85/family-archive.git
  DEFAULT_BRANCH=main
  POCKETBASE_VERSION=0.39.10
  # shellcheck disable=SC2034 # Значения читаются косвенно через имя переменной.
  POCKETBASE_SHA256_LINUX_ARM64=5bad497eaf2522418673eacfcc90e75106036f19b4aeeac6e59bc48503c01ddf
  # shellcheck disable=SC2034 # Значения читаются косвенно через имя переменной.
  POCKETBASE_SHA256_LINUX_AMD64=67f68c8041dbb6a35fd7af5997ffc5063a7a7b96bf9df810360788f9e9975408
  # shellcheck disable=SC2034 # Значения читаются косвенно через имя переменной.
  POCKETBASE_SHA256_LINUX_ARMV7=6845a91fe31867b76abc3d598a5d33ac1cb3e77a3c0d51b6fb6184ddd28b6435
  KEEP_RELEASES=3
  KEEP_BACKUPS=7
  MIN_FREE_MB=512
  HEALTH_RETRIES=30
  HEALTH_DELAY_SECONDS=1
}

deployment_config_key_is_allowed() {
  local requested=$1 key
  for key in "${DEPLOYMENT_CONFIG_KEYS[@]}"; do
    [[ $key == "$requested" ]] && return 0
  done
  return 1
}

validate_config_file_security() {
  local file=$1 owner mode permissions
  [[ -f $file && ! -L $file && -r $file ]] ||
    die "Deployment-конфиг должен быть обычным читаемым файлом, а не симлинком: $file"
  owner="$(stat -c '%u' "$file")"
  mode="$(stat -c '%a' "$file")"
  [[ $mode =~ ^[0-7]{3,4}$ ]] || die "Не удалось проверить права deployment-конфига: $file"
  permissions=$((8#$mode))
  (( (permissions & 0022) == 0 )) ||
    die "Deployment-конфиг не должен быть доступен на запись группе или остальным: $file"
  (( EUID != 0 || owner == 0 )) || die "При запуске от root deployment-конфиг должен принадлежать root: $file"
}

parse_deployment_config() {
  local file=$1 line key value line_number=0
  local -A seen=()
  while IFS= read -r line || [[ -n $line ]]; do
    ((line_number += 1))
    [[ $line != *$'\r'* ]] || die "Deployment-конфиг содержит CR или многострочное значение (строка $line_number)."
    [[ -z $line || $line == \#* ]] && continue
    [[ $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
      die "Deployment-конфиг допускает только строки KEY=VALUE (строка $line_number)."
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    deployment_config_key_is_allowed "$key" || die "Неизвестный ключ deployment-конфига: $key"
    [[ -z ${seen[$key]:-} ]] || die "Ключ deployment-конфига указан повторно: $key"
    seen[$key]=1
    config_value_has_forbidden_metachar "$value" &&
      die "Значение $key содержит shell-конструкцию или запрещённый метасимвол."
    if [[ $key != SITE_NAME ]]; then
      [[ $value != *[[:space:]]* ]] || die "Значение $key не должно содержать пробельные символы."
    fi
    printf -v "$key" '%s' "$value"
  done < "$file"
  if [[ -n ${seen[LISTEN_ADDRESS]:-} ]]; then
    [[ -z ${seen[LISTEN_HOST]:-} && -z ${seen[PORT]:-} ]] ||
      die "LISTEN_ADDRESS нельзя смешивать с LISTEN_HOST или PORT."
    [[ $LISTEN_ADDRESS =~ ^([^:]+):([0-9]{1,5})$ ]] ||
      die "Устаревший LISTEN_ADDRESS имеет некорректный формат."
    LISTEN_HOST=${BASH_REMATCH[1]}
    PORT=${BASH_REMATCH[2]}
    warn "LISTEN_ADDRESS устарел; при следующей записи будет сохранён как LISTEN_HOST и PORT."
  fi
}

config_value_has_forbidden_metachar() {
  local value=$1 metachar
  for metachar in '$' '`' '<' '>' '&' '|' ';' '(' ')' '{' '}' '!' '*' '?' '[' ']' '~' "'" '"' $'\\'; do
    [[ $value != *"$metachar"* ]] || return 0
  done
  return 1
}

validate_config() {
  local checksum_name checksum_value
  [[ ${APP_NAME:-} =~ ^[a-z][a-z0-9-]*$ ]] || die "Некорректный APP_NAME."
  validate_site_name "$SITE_NAME"
  [[ ${INSTALL_ROOT:-} =~ ^/[A-Za-z0-9._/-]+$ && $INSTALL_ROOT != / && $INSTALL_ROOT != */ ]] ||
    die "INSTALL_ROOT должен быть абсолютным путём без пробелов, без завершающего / и не может быть /."
  path_entry_is_safe "${INSTALL_ROOT#/}" || die "INSTALL_ROOT содержит небезопасные компоненты пути."
  [[ $INSTALL_ROOT != /home && $INSTALL_ROOT != /home/* && $INSTALL_ROOT != /root && $INSTALL_ROOT != /root/* ]] ||
    die "INSTALL_ROOT не может находиться в /home или /root при ProtectHome=true."
  [[ ${SERVICE_NAME:-} =~ ^[A-Za-z0-9_.@-]+$ ]] || die "Некорректный SERVICE_NAME."
  [[ ${SERVICE_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Некорректный SERVICE_USER."
  [[ ${SERVICE_GROUP:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Некорректный SERVICE_GROUP."
  validate_listen_host "$LISTEN_HOST"
  validate_port "$PORT"
  validate_timezone "$TIMEZONE"
  [[ $ENABLE_SYSTEMD == true || $ENABLE_SYSTEMD == false ]] || die "ENABLE_SYSTEMD допускает только true или false."
  [[ ${REPOSITORY_URL:-} =~ ^https://[A-Za-z0-9._~:/@%+=,-]+$ ]] ||
    die "REPOSITORY_URL должен быть HTTPS URL без shell-метасимволов."
  [[ -n ${DEFAULT_BRANCH:-} && $DEFAULT_BRANCH != -* && $DEFAULT_BRANCH != *[[:space:]]* &&
    $DEFAULT_BRANCH != *..* && $DEFAULT_BRANCH != *@\{* ]] || die "Некорректный DEFAULT_BRANCH."
  [[ ${POCKETBASE_VERSION:-} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Некорректный POCKETBASE_VERSION."
  for checksum_name in POCKETBASE_SHA256_LINUX_ARM64 POCKETBASE_SHA256_LINUX_AMD64 POCKETBASE_SHA256_LINUX_ARMV7; do
    checksum_value=${!checksum_name:-}
    [[ $checksum_value =~ ^[0-9a-fA-F]{64}$ ]] || die "$checksum_name должен содержать SHA-256 из 64 hex-символов."
  done
  validate_positive_integer KEEP_RELEASES "$KEEP_RELEASES"
  validate_positive_integer KEEP_BACKUPS "$KEEP_BACKUPS"
  validate_positive_integer MIN_FREE_MB "$MIN_FREE_MB"
  validate_positive_integer HEALTH_RETRIES "$HEALTH_RETRIES"
  validate_positive_integer HEALTH_DELAY_SECONDS "$HEALTH_DELAY_SECONDS"
}

validate_site_name() {
  local value=$1
  [[ -n $value && ${#value} -le 120 && $value != *$'\n'* && $value != *$'\r'* ]] ||
    die "SITE_NAME должен содержать от 1 до 120 символов в одной строке."
  config_value_has_forbidden_metachar "$value" && die "SITE_NAME содержит запрещённый метасимвол."
  return 0
}

validate_port() {
  local value=$1
  [[ $value =~ ^[0-9]+$ ]] || die "PORT должен быть целым числом."
  (( ${#value} <= 5 )) || die "PORT должен быть в диапазоне 1024–65535."
  (( 10#$value >= 1024 && 10#$value <= 65535 )) || die "PORT должен быть в диапазоне 1024–65535."
}

ipv4_is_valid() {
  local value=$1 octet
  local -a octets
  [[ $value =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r -a octets <<< "$value"
  for octet in "${octets[@]}"; do
    [[ $octet =~ ^[0-9]{1,3}$ ]] && (( 10#$octet <= 255 )) || return 1
  done
}

listen_host_is_local_address() {
  local value=$1
  command -v ip >/dev/null 2>&1 || return 1
  ip -o addr show 2>/dev/null | awk -v requested="$value" '{ address=$4; sub(/\/.*/, "", address); if (address == requested) found=1 } END { exit !found }'
}

validate_listen_host() {
  local value=$1
  case "$value" in
    127.0.0.1|0.0.0.0|::1|::) return 0 ;;
  esac
  if ipv4_is_valid "$value" || [[ $value == *:* && $value =~ ^[0-9A-Fa-f:]+$ ]]; then
    listen_host_is_local_address "$value" || die "LISTEN_HOST не назначен локальному интерфейсу: $value"
    return 0
  fi
  die "LISTEN_HOST должен быть loopback, wildcard или корректным локальным IP."
}

system_timezone() {
  local zone=""
  if command -v timedatectl >/dev/null 2>&1; then
    zone=$(timedatectl show --property=Timezone --value 2>/dev/null || true)
  fi
  if [[ -z $zone && -L /etc/localtime ]]; then
    zone=$(readlink -f /etc/localtime 2>/dev/null || true)
    zone=${zone#*/zoneinfo/}
  fi
  printf '%s\n' "${zone:-UTC}"
}

validate_timezone() {
  local zone=$1
  [[ -n $zone && $zone != /* && $zone != *..* && $zone != *[[:space:]]* ]] ||
    die "Некорректный TIMEZONE."
  if command -v timedatectl >/dev/null 2>&1 &&
    timedatectl list-timezones 2>/dev/null | grep -Fqx -- "$zone"; then
    return 0
  fi
  [[ -e /usr/share/zoneinfo/$zone ]] ||
    die "Неизвестный часовой пояс: $zone"
}

validate_positive_integer() {
  local name=$1 value=$2
  [[ $value =~ ^[1-9][0-9]*$ ]] || die "$name должен быть положительным целым числом."
}

require_root() {
  (( EUID == 0 )) || die "Запустите скрипт от root, например через sudo."
}

require_commands() {
  local missing=() command
  for command in "$@"; do
    command -v "$command" >/dev/null 2>&1 || missing+=("$command")
  done
  ((${#missing[@]} == 0)) || die "Не найдены обязательные команды: ${missing[*]}"
}

install_missing_system_packages() {
  local -a packages=() required_commands=(git curl unzip rsync jq node npm systemctl tar sha256sum flock ss)
  local command package
  for command in "${required_commands[@]}"; do
    command -v "$command" >/dev/null 2>&1 && continue
    case "$command" in
      git) package=git ;;
      curl) package=curl ;;
      unzip) package=unzip ;;
      rsync) package=rsync ;;
      jq) package=jq ;;
      node) package=nodejs ;;
      npm) package=npm ;;
      systemctl) package=systemd ;;
      tar) package=tar ;;
      sha256sum) package=coreutils ;;
      flock) package=util-linux ;;
      ss) package=iproute2 ;;
    esac
    [[ " ${packages[*]} " == *" $package "* ]] || packages+=("$package")
  done
  dpkg-query -W -f='${Status}' ca-certificates 2>/dev/null | grep -q 'install ok installed' || packages+=(ca-certificates)

  if ((${#packages[@]})); then
    log "Устанавливаю недостающие пакеты: ${packages[*]}"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
  else
    log "Все необходимые системные пакеты уже установлены."
  fi
  require_commands "${required_commands[@]}"
}

check_node_version() {
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])")"
  (( major >= 18 )) || die "Нужен Node.js 18 или новее; установлен $(node --version). Для разработки рекомендуется Node.js 22."
}

pocketbase_arch_for() {
  local machine=$1
  case "$machine" in
    aarch64|arm64) printf 'linux_arm64\n' ;;
    x86_64|amd64) printf 'linux_amd64\n' ;;
    armv7l) printf 'linux_armv7\n' ;;
    *) die "Архитектура '$machine' не поддерживается. Поддерживаются arm64/aarch64, armv7l и amd64/x86_64." ;;
  esac
}

pocketbase_checksum() {
  local architecture=$1 variable
  variable="POCKETBASE_SHA256_${architecture^^}"
  variable=${variable//[^A-Z0-9_]/_}
  [[ -n ${!variable:-} ]] || die "Для $architecture не задан SHA-256 ($variable)."
  printf '%s\n' "${!variable}"
}

path_entry_is_safe() {
  local entry=$1
  [[ -n $entry && $entry != /* && ${entry//\\/} == "$entry" ]] || return 1
  [[ ! $entry =~ (^|/)\.\.(/|$) ]]
}

validate_tar_archive() {
  local archive=$1 entry normalized mode remainder found_data=0
  [[ -f $archive ]] || die "Архив не найден: $archive"
  tar -tzf "$archive" >/dev/null || die "Архив повреждён или не является tar.gz: $archive"
  while IFS= read -r entry; do
    path_entry_is_safe "$entry" || die "Архив содержит небезопасный путь: $entry"
    normalized=${entry#./}
    [[ $normalized == pb_data || $normalized == pb_data/* ]] && found_data=1
  done < <(tar -tzf "$archive")
  while IFS=' ' read -r mode remainder; do
    [[ ${mode:0:1} == - || ${mode:0:1} == d ]] || die "Архив содержит ссылку или специальный файл: $remainder"
  done < <(tar -tvzf "$archive")
  (( found_data )) || die "В архиве отсутствует pb_data."
}

resolve_remote_commit() {
  local requested_ref=${1:-} branch=${2:-$DEFAULT_BRANCH} output commit
  [[ -z $requested_ref || $requested_ref != -* && $requested_ref != *[[:space:]]* &&
    $requested_ref != *..* && $requested_ref != *@\{* ]] || die "Некорректный Git ref: '$requested_ref'."
  if [[ $requested_ref =~ ^[0-9a-fA-F]{40}$ ]]; then
    printf '%s\n' "${requested_ref,,}"
    return
  elif [[ -z $requested_ref ]]; then
    output="$(git ls-remote "$REPOSITORY_URL" "refs/heads/$branch")"
  else
    output="$(git ls-remote "$REPOSITORY_URL" \
      "$requested_ref" "refs/heads/$requested_ref" \
      "refs/tags/$requested_ref" "refs/tags/$requested_ref^{}")"
  fi
  commit="$(awk '$2 ~ /\^\{\}$/ {peeled=$1} NR == 1 {first=$1} END {print peeled ? peeled : first}' <<< "$output")"
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || die "Не удалось разрешить remote ref '${requested_ref:-$branch}'."
  printf '%s\n' "$commit"
}

validate_zip_archive() {
  local archive=$1 entry
  unzip -tq "$archive" >/dev/null
  while IFS= read -r entry; do
    path_entry_is_safe "$entry" || die "ZIP содержит небезопасный путь: $entry"
  done < <(unzip -Z1 "$archive")
}

verify_backup_checksum() {
  local archive=$1 checksum_file expected filename extra actual
  checksum_file="$archive.sha256"
  [[ -f $checksum_file ]] || return 2
  IFS=' ' read -r expected filename extra < "$checksum_file"
  [[ $expected =~ ^[0-9a-fA-F]{64}$ && $filename == "$(basename "$archive")" && -z ${extra:-} ]] \
    || die "Некорректный формат checksum: $checksum_file"
  actual="$(sha256sum "$archive" | awk '{print $1}')"
  [[ ${actual,,} == "${expected,,}" ]] || die "Checksum backup не совпал: $archive"
}

download_pocketbase() {
  local destination=$1 architecture archive_name expected archive_dir archive
  architecture="$(pocketbase_arch_for "$(uname -m)")"
  expected="$(pocketbase_checksum "$architecture")"
  archive_name="pocketbase_${POCKETBASE_VERSION}_${architecture}.zip"
  make_temp_dir archive_dir 'family-archive-pocketbase.XXXXXX'
  archive="$archive_dir/$archive_name"
  log "Скачиваю PocketBase ${POCKETBASE_VERSION} ($architecture)."
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 \
    "https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/${archive_name}" \
    --output "$archive"
  printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status - || die "SHA-256 PocketBase не совпал."
  validate_zip_archive "$archive"
  unzip -q "$archive" pocketbase -d "$destination"
  chmod 0755 "$destination/pocketbase"
}

validate_migrations() {
  local directory=$1 migration found=0
  [[ -d $directory ]] || die "Каталог миграций не найден: $directory"
  while IFS= read -r -d '' migration; do
    found=1
    node --check "$migration"
  done < <(find "$directory" -maxdepth 1 -type f -name '*.js' -print0)
  (( found )) || warn "В $directory нет JavaScript-миграций."
}

run_frontend_checks() {
  local source_dir=$1
  [[ -f $source_dir/frontend/package-lock.json ]] || die "В исходниках нет frontend/package-lock.json."
  (
    cd "$source_dir/frontend" || exit
    npm ci --no-audit --no-fund
    npm run lint
    npm run format:check
    npm run check
    npm test
    npm run build
  )
}

prepare_repository_cache() {
  local mirror="$INSTALL_ROOT/app/repository.git"
  if [[ -d $mirror/objects ]]; then
    git --git-dir="$mirror" remote set-url origin "$REPOSITORY_URL"
    git --git-dir="$mirror" remote update --prune
  else
    [[ ! -e $mirror ]] || die "$mirror существует, но не является Git mirror."
    git clone --mirror "$REPOSITORY_URL" "$mirror"
  fi
}

resolve_cached_commit() {
  local requested_ref=${1:-} branch=${2:-$DEFAULT_BRANCH} mirror="$INSTALL_ROOT/app/repository.git" candidate
  if [[ -z $requested_ref ]]; then
    candidate="refs/heads/$branch"
  elif git --git-dir="$mirror" rev-parse --verify --quiet "${requested_ref}^{commit}" >/dev/null; then
    candidate=$requested_ref
  elif git --git-dir="$mirror" rev-parse --verify --quiet "refs/heads/${requested_ref}^{commit}" >/dev/null; then
    candidate="refs/heads/$requested_ref"
  elif git --git-dir="$mirror" rev-parse --verify --quiet "refs/tags/${requested_ref}^{commit}" >/dev/null; then
    candidate="refs/tags/$requested_ref"
  else
    die "Ref '$requested_ref' не найден в $REPOSITORY_URL."
  fi
  git --git-dir="$mirror" rev-parse "${candidate}^{commit}"
}

checkout_cached_source() {
  local commit=$1 destination=$2 mirror="$INSTALL_ROOT/app/repository.git"
  git clone --no-checkout --shared "$mirror" "$destination"
  git -C "$destination" checkout --detach "$commit"
  git -C "$destination" remote set-url origin "$REPOSITORY_URL"
}

write_release_metadata() {
  local release=$1 commit=$2 source_ref=$3 source_branch=$4 app_version=${5:-unknown} deployed_at
  deployed_at="$(date --iso-8601=seconds)"
  {
    printf 'COMMIT=%q\n' "$commit"
    printf 'SOURCE_REF=%q\n' "$source_ref"
    printf 'SOURCE_BRANCH=%q\n' "$source_branch"
    printf 'APP_VERSION=%q\n' "$app_version"
    printf 'POCKETBASE_VERSION=%q\n' "$POCKETBASE_VERSION"
    printf 'DEPLOYED_AT=%q\n' "$deployed_at"
  } > "$release/release.env"
  chmod 0644 "$release/release.env"
}

assemble_release() {
  local source_dir=$1 release_dir=$2 commit=$3 source_ref=$4 source_branch=$5 app_version
  mkdir -p "$release_dir/pb_public" "$release_dir/pb_migrations" "$release_dir/config" "$release_dir/scripts"
  download_pocketbase "$release_dir"
  rsync -a --delete "$source_dir/pb_public/" "$release_dir/pb_public/"
  rsync -a --delete "$source_dir/pb_migrations/" "$release_dir/pb_migrations/"
  rsync -a --delete "$source_dir/scripts/" "$release_dir/scripts/"
  install -m 0644 "$source_dir/config/deployment.env.example" "$release_dir/config/deployment.env.example"
  ln -s "$INSTALL_ROOT/shared/pb_data" "$release_dir/pb_data"
  app_version="$(jq -r '.version' "$source_dir/frontend/package.json")"
  [[ $app_version =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] ||
    die "Некорректная версия frontend/package.json: $app_version"
  write_release_metadata "$release_dir" "$commit" "$source_ref" "$source_branch" "$app_version"
  finalize_release_permissions "$release_dir"
}

finalize_release_permissions() {
  local release_dir=$1
  chmod 0755 "$release_dir"
  chmod -R a-w "$release_dir/pb_public" "$release_dir/pb_migrations" \
    "$release_dir/config" "$release_dir/scripts"
}

read_release_value() {
  local release=$1 key=$2 value
  [[ -f $release/release.env ]] || return 1
  value="$(sed -n "s/^${key}=//p" "$release/release.env" | head -n 1)"
  [[ -n $value ]] || return 1
  # release.env генерируется только нашими скриптами с printf %q.
  eval "printf '%s\\n' $value"
}

release_is_valid() {
  local release=$1
  [[ -d $release && -x $release/pocketbase && -d $release/pb_public &&
    -d $release/pb_migrations && -f $release/release.env ]]
}

current_release() {
  local release
  [[ -L $INSTALL_ROOT/current ]] || return 1
  release="$(readlink -f "$INSTALL_ROOT/current")"
  [[ $release == "$INSTALL_ROOT/releases/"* ]] || return 1
  release_is_valid "$release" || return 1
  printf '%s\n' "$release"
}

current_commit() {
  local release
  release="$(current_release)" || return 1
  read_release_value "$release" COMMIT
}

atomic_symlink() {
  local target=$1 link=$2 staging
  make_temp_dir staging "$(dirname "$link")/.family-archive-link.XXXXXX"
  ln -s "$target" "$staging/link"
  mv -Tf "$staging/link" "$link"
}

install_cli_launchers() {
  local bin_dir=${FAMILY_ARCHIVE_CLI_BIN_DIR:-/usr/local/bin}
  local launcher_target="$INSTALL_ROOT/current/scripts/family-archive.sh"
  local path command
  if [[ ! -x $launcher_target ]]; then
    warn "Launcher не найден в release: $launcher_target"
    return 1
  fi
  mkdir -p "$bin_dir" || return 1

  path="$bin_dir/family-archive"
  if [[ -e $path || -L $path ]]; then
    if [[ ! -L $path || $(readlink "$path") != "$launcher_target" ]]; then
      warn "$path уже существует и не является launcher этой установки."
      return 1
    fi
  fi
  for command in update backup rollback status; do
    path="$bin_dir/family-archive-$command"
    if [[ -e $path || -L $path ]]; then
      if [[ ! -L $path || $(readlink "$path") != family-archive ]]; then
        warn "$path уже существует и не является совместимой командой Family Archive."
        return 1
      fi
    fi
  done

  path="$bin_dir/family-archive"
  if [[ ! -e $path && ! -L $path ]]; then
    if ! atomic_symlink "$launcher_target" "$path"; then
      remove_created_cli_launchers
      return 1
    fi
    CLI_CREATED_PATHS+=("$path")
  fi
  for command in update backup rollback status; do
    path="$bin_dir/family-archive-$command"
    if [[ ! -e $path && ! -L $path ]]; then
      if ! atomic_symlink family-archive "$path"; then
        remove_created_cli_launchers
        return 1
      fi
      CLI_CREATED_PATHS+=("$path")
    fi
  done
}

remove_created_cli_launchers() {
  local path expected
  for path in "${CLI_CREATED_PATHS[@]:-}"; do
    if [[ ${path##*/} == family-archive ]]; then
      expected="$INSTALL_ROOT/current/scripts/family-archive.sh"
    else
      expected=family-archive
    fi
    if [[ -L $path && $(readlink "$path") == "$expected" ]]; then
      rm -f -- "$path"
    fi
  done
  CLI_CREATED_PATHS=()
}

remove_cli_launchers() {
  local bin_dir=${FAMILY_ARCHIVE_CLI_BIN_DIR:-/usr/local/bin}
  local launcher_target="$INSTALL_ROOT/current/scripts/family-archive.sh"
  local path command
  for command in update backup rollback status; do
    path="$bin_dir/family-archive-$command"
    if [[ -L $path && $(readlink "$path") == family-archive ]]; then
      rm -f -- "$path"
    fi
  done
  path="$bin_dir/family-archive"
  if [[ -L $path && $(readlink "$path") == "$launcher_target" ]]; then
    rm -f -- "$path"
  fi
  CLI_CREATED_PATHS=()
}

listen_host() { printf '%s\n' "$LISTEN_HOST"; }

listen_port() { printf '%s\n' "$PORT"; }

format_host_for_url() {
  [[ $1 == *:* ]] && printf '[%s]' "$1" || printf '%s' "$1"
}

listen_address() {
  if [[ $LISTEN_HOST == *:* ]]; then
    printf '[%s]:%s\n' "$LISTEN_HOST" "$PORT"
  else
    printf '%s:%s\n' "$LISTEN_HOST" "$PORT"
  fi
}

health_host() {
  case "$LISTEN_HOST" in
    0.0.0.0) printf '127.0.0.1\n' ;;
    ::) printf '::1\n' ;;
    *) printf '%s\n' "$LISTEN_HOST" ;;
  esac
}

local_base_url() {
  printf 'http://%s:%s\n' "$(format_host_for_url "$(health_host)")" "$PORT"
}

ip_is_private() {
  local value=$1
  [[ $value =~ ^10\. || $value =~ ^192\.168\. || $value =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ||
    $value =~ ^169\.254\. || $value =~ ^[fF][cCdD] || $value =~ ^[fF][eE][89aAbB] ]]
}

network_addresses() {
  local primary="" address
  command -v ip >/dev/null 2>&1 || return 0
  primary=$(ip route get 1.1.1.1 2>/dev/null | awk '{ for (i=1; i<=NF; i++) if ($i == "src") { print $(i+1); exit } }')
  if [[ -n $primary ]] && ip_is_private "$primary"; then
    printf '%s\n' "$primary"
    return 0
  fi
  while IFS= read -r address; do
    ip_is_private "$address" && printf '%s\n' "$address"
  done < <(ip -o addr show scope global 2>/dev/null | awk '{ address=$4; sub(/\/.*/, "", address); print address }' | awk '!seen[$0]++')
}

print_install_summary() {
  local commit=$1 version=${2:-unknown} service_state address found=0
  if [[ $ENABLE_SYSTEMD == true ]]; then
    service_state=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || printf inactive)
  else
    service_state='не установлен (--no-systemd)'
  fi
  printf '\n==================================================\n Family Archive установлен успешно\n==================================================\n\n'
  printf '%-15s %s\n' \
    'Версия:' "$version" \
    'Commit:' "$commit" \
    'Каталог:' "$INSTALL_ROOT" \
    'Сервис:' "$service_state" \
    'Порт:' "$PORT" \
    'Локальный URL:' "$(local_base_url)"
  local -a summary_addresses=()
  case "$LISTEN_HOST" in
    0.0.0.0|::) mapfile -t summary_addresses < <(network_addresses) ;;
    127.0.0.1|::1) ;;
    *) summary_addresses+=("$LISTEN_HOST") ;;
  esac
  for address in "${summary_addresses[@]:-}"; do
    [[ -n $address ]] || continue
    printf '%-15s http://%s:%s\n' "$([[ $found == 0 ]] && printf 'Сетевой URL:' || printf '')" \
      "$(format_host_for_url "$address")" "$PORT"
    ((found += 1))
  done
  if (( found )); then
    address=${summary_addresses[0]}
    printf '%-15s http://%s:%s/_/\n' 'Админка:' "$(format_host_for_url "$address")" "$PORT"
  else
    printf '%-15s %s/_/\n' 'Админка:' "$(local_base_url)"
  fi
  printf '%-15s %s/api/health\n\n' 'Health:' "$(local_base_url)"
  printf 'Команды:\n\nfamily-archive status\nfamily-archive doctor\nfamily-archive backup\nfamily-archive update\n\n==================================================\n'
}

tcp_port_is_listening() {
  local requested=${1:-$PORT} listeners
  if command -v ss >/dev/null 2>&1; then
    listeners=$(ss -ltnH "sport = :$requested" 2>/dev/null) || return 1
    [[ -n $listeners ]] || return 1
    return 0
  fi
  local hex
  printf -v hex '%04X' "$requested"
  awk -v suffix=":$hex" '$2 ~ suffix"$" && $4 == "0A" { found=1 } END { exit !found }' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

systemd_socket_uses_port() {
  local requested=${1:-$PORT}
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl list-sockets --all --no-legend --no-pager 2>/dev/null |
    awk -v port="$requested" '{ for (i=1; i<=NF; i++) if ($i == port || $i ~ ":" port "$") found=1 } END { exit !found }'
}

port_is_listening() { tcp_port_is_listening "$PORT"; }

port_is_available() {
  local requested=${1:-$PORT}
  ! tcp_port_is_listening "$requested" && ! systemd_socket_uses_port "$requested"
}

port_listener_details() {
  local requested=${1:-$PORT} details=""
  if command -v ss >/dev/null 2>&1; then
    details=$(ss -ltnpH "sport = :$requested" 2>/dev/null || true)
  fi
  if systemd_socket_uses_port "$requested"; then
    details+="${details:+$'\n'}systemd socket: $(systemctl list-sockets --all --no-legend --no-pager 2>/dev/null | awk -v port="$requested" '{ for (i=1; i<=NF; i++) if ($i == port || $i ~ ":" port "$") { print; next } }')"
  fi
  printf '%s\n' "${details:-владелец не определён}"
}

unit_http_endpoint() {
  local text
  command -v systemctl >/dev/null 2>&1 || return 1
  text=$(systemctl cat "$SERVICE_NAME" 2>/dev/null || true)
  sed -n 's/^ExecStart=.* serve --http=\([^ ]*\).*/\1/p' <<< "$text" | head -n 1
}

endpoint_port() {
  local endpoint=$1
  [[ $endpoint =~ :([0-9]+)$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

systemd_main_pid() {
  systemctl show "$SERVICE_NAME" --property=MainPID --value 2>/dev/null || true
}

service_listening_ports() {
  local pid
  pid=$(systemd_main_pid)
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 0
  ss -ltnpH 2>/dev/null | awk -v marker="pid=$pid," \
    'index($0, marker) { address=$4; sub(/^.*:/, "", address); if (address ~ /^[0-9]+$/ && !seen[address]++) print address }'
}

configured_port_owned_by_service() {
  local pid details
  pid=$(systemd_main_pid)
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  details=$(ss -ltnpH "sport = :$PORT" 2>/dev/null || true)
  [[ $details == *"pid=$pid,"* ]]
}

require_available_port() {
  local requested=$1
  validate_port "$requested"
  if ! port_is_available "$requested"; then
    printf 'Порт %s занят:\n%s\n' "$requested" "$(port_listener_details "$requested")" >&2
    die "Выберите другой HTTP-порт."
  fi
}

find_first_available_port() {
  local candidate start=${1:-8090} end=${2:-8190}
  for ((candidate=start; candidate<=end; candidate++)); do
    if port_is_available "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

http_status_code() {
  local path=${1:-/}
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --noproxy '*' --connect-timeout 2 --max-time 5 "$(local_base_url)$path" || true
}

api_health_ok() {
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    --noproxy '*' \
    "$(local_base_url)/api/health" >/dev/null
}

health_check_once() {
  { [[ $ENABLE_SYSTEMD == false ]] || systemctl is-active --quiet "$SERVICE_NAME"; } &&
    port_is_listening &&
    [[ $(http_status_code /) == 200 ]] &&
    api_health_ok
}

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
    if health_check_once; then
      return 0
    fi
    sleep "$HEALTH_DELAY_SECONDS"
  done
  return 1
}

check_free_space() {
  local path=${1:-$INSTALL_ROOT} available_kb required_kb
  [[ -e $path ]] || path="$(dirname "$path")"
  available_kb="$(df -Pk "$path" | awk 'NR == 2 {print $4}')"
  required_kb=$((MIN_FREE_MB * 1024))
  (( available_kb >= required_kb )) || die "Недостаточно места: нужно минимум ${MIN_FREE_MB} MiB, доступно $((available_kb / 1024)) MiB."
}

acquire_update_lock() {
  if [[ ${FAMILY_ARCHIVE_UPDATE_LOCK_HELD:-0} == 1 ]]; then
    return 0
  fi
  mkdir -p "$INSTALL_ROOT/shared"
  exec 9>"$INSTALL_ROOT/shared/update.lock"
  flock -n 9 || die "Уже выполняется install/update/backup/rollback (lock: $INSTALL_ROOT/shared/update.lock)."
  export FAMILY_ARCHIVE_UPDATE_LOCK_HELD=1
}

write_install_config() {
  local destination=$1 staging temporary
  mkdir -p "$(dirname "$destination")"
  make_temp_dir staging "$(dirname "$destination")/.family-archive-config.XXXXXX"
  temporary="$staging/deployment.env"
  {
    printf '# Создано Family Archive deployment scripts. Не храните здесь секреты.\n'
    local key
    for key in APP_NAME SITE_NAME INSTALL_ROOT SERVICE_USER SERVICE_GROUP SERVICE_NAME LISTEN_HOST PORT TIMEZONE ENABLE_SYSTEMD \
      REPOSITORY_URL DEFAULT_BRANCH POCKETBASE_VERSION POCKETBASE_SHA256_LINUX_ARM64 \
      POCKETBASE_SHA256_LINUX_AMD64 POCKETBASE_SHA256_LINUX_ARMV7 KEEP_RELEASES \
      KEEP_BACKUPS MIN_FREE_MB HEALTH_RETRIES HEALTH_DELAY_SECONDS; do
      printf '%s=%s\n' "$key" "${!key}"
    done
  } > "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$destination"
}

write_systemd_unit() {
  local destination=$1 staging temporary
  mkdir -p "$(dirname "$destination")"
  make_temp_dir staging "$(dirname "$destination")/.family-archive-unit.XXXXXX"
  temporary="$staging/${SERVICE_NAME}.service"
  {
    printf '%s\n' \
      '[Unit]' \
      'Description=Family Archive PocketBase' \
      'After=network-online.target' \
      'Wants=network-online.target' \
      '' \
      '[Service]' \
      'Type=simple' \
      "User=$SERVICE_USER" \
      "Group=$SERVICE_GROUP" \
      "WorkingDirectory=$INSTALL_ROOT/current" \
      "Environment=TZ=$TIMEZONE" \
      "ExecStart=$INSTALL_ROOT/current/pocketbase serve --http=$(listen_address) --dir=$INSTALL_ROOT/shared/pb_data --publicDir=$INSTALL_ROOT/current/pb_public --migrationsDir=$INSTALL_ROOT/current/pb_migrations --automigrate=false" \
      'Restart=on-failure' \
      'RestartSec=5' \
      'LimitNOFILE=4096' \
      'UMask=0027' \
      'NoNewPrivileges=true' \
      'PrivateTmp=true' \
      'PrivateDevices=true' \
      'ProtectSystem=strict' \
      'ProtectHome=true' \
      'ProtectKernelTunables=true' \
      'ProtectKernelModules=true' \
      'ProtectControlGroups=true' \
      'RestrictSUIDSGID=true' \
      'LockPersonality=true' \
      "ReadWritePaths=$INSTALL_ROOT/shared/pb_data" \
      '' \
      '[Install]' \
      'WantedBy=multi-user.target'
  } > "$temporary"
  chmod 0644 "$temporary"
  mv -f "$temporary" "$destination"
}

change_port_transaction() {
  local new_port=$1 config_path=$2 shared_config=$3 unit_path=$4 recovery_dir=$5
  local old_port=$PORT result=0
  validate_port "$new_port"
  [[ $new_port != "$old_port" ]] || die "Новый порт совпадает с текущим: $old_port"
  require_available_port "$new_port"
  mkdir -p "$recovery_dir"
  install -m 0600 "$config_path" "$recovery_dir/deployment.env"
  install -m 0600 "$shared_config" "$recovery_dir/shared-deployment.env"
  install -m 0644 "$unit_path" "$recovery_dir/service.unit"
  PORT=$new_port
  write_install_config "$config_path"
  install -m 0600 "$config_path" "$shared_config"
  write_systemd_unit "$unit_path"
  systemctl daemon-reload
  systemctl restart "$SERVICE_NAME" && wait_for_health && return 0

  result=$?
  warn "Health check на порту $new_port не прошёл; возвращаю прежний порт $old_port."
  systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  install -m 0600 "$recovery_dir/deployment.env" "$config_path"
  install -m 0600 "$recovery_dir/shared-deployment.env" "$shared_config"
  install -m 0644 "$recovery_dir/service.unit" "$unit_path"
  PORT=$old_port
  systemctl daemon-reload
  systemctl restart "$SERVICE_NAME" >/dev/null 2>&1 || true
  wait_for_health || warn "После rollback прежняя конфигурация также не прошла health check."
  return "${result:-1}"
}

apply_migrations() {
  local release=$1
  runuser -u "$SERVICE_USER" -- "$release/pocketbase" migrate up \
    --dir="$INSTALL_ROOT/shared/pb_data" \
    --migrationsDir="$release/pb_migrations"
}

migrations_differ() {
  local old_release=$1 new_release=$2
  [[ -d $old_release/pb_migrations ]] || return 0
  ! diff -qr "$old_release/pb_migrations" "$new_release/pb_migrations" >/dev/null 2>&1
}

prune_releases() {
  local keep=$1 current path count=0 failed=0
  current="$(current_release 2>/dev/null || true)"
  while IFS= read -r path; do
    [[ -n $path ]] || continue
    if ! release_is_valid "$path"; then
      warn "Пропускаю неизвестный или неполный каталог в releases: $path"
      continue
    fi
    ((count += 1))
    if (( count > keep )) && [[ $path != "$current" ]]; then
      log "Удаляю старый release: $path"
      rm -rf -- "$path" || failed=1
    fi
  done < <(find "$INSTALL_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  return "$failed"
}

prune_backups() {
  local directory=$1 keep=$2 path count=0 failed=0
  while IFS= read -r path; do
    [[ -n $path ]] || continue
    ((count += 1))
    if (( count > keep )); then
      rm -f -- "$path" "$path.sha256" || failed=1
    fi
  done < <(find "$directory" -maxdepth 1 -type f -name 'family-archive-*.tar.gz' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  return "$failed"
}

extract_verified_backup() {
  local archive=$1 destination=$2
  validate_tar_archive "$archive"
  mkdir -p "$destination" || die "Не удалось создать каталог распаковки: $destination"
  tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$destination" ||
    die "Не удалось распаковать проверенный backup: $archive"
  [[ -d $destination/pb_data ]] || die "После распаковки не найден pb_data."
}

restore_data_from_backup() {
  local archive=$1 safety_suffix=${2:-$(date +%Y%m%d-%H%M%S)} extract_dir staged_dir old_dir
  RESTORED_PREVIOUS_DATA=""
  make_temp_dir extract_dir 'family-archive-restore.XXXXXX'
  extract_verified_backup "$archive" "$extract_dir"
  make_temp_dir staged_dir "$INSTALL_ROOT/shared/.pb-data-restore.XXXXXX"
  mkdir -p "$staged_dir/pb_data" || die "Не удалось создать staging pb_data."
  rsync -a --delete "$extract_dir/pb_data/" "$staged_dir/pb_data/" ||
    die "Не удалось скопировать данные backup в staging."
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$staged_dir/pb_data" ||
    die "Не удалось назначить владельца восстановленным данным."
  chmod 0750 "$staged_dir/pb_data" || die "Не удалось назначить права восстановленным данным."
  old_dir="$INSTALL_ROOT/shared/pb_data.before-restore-$safety_suffix"
  [[ ! -e $old_dir ]] || die "Защитный каталог уже существует: $old_dir"
  mv "$INSTALL_ROOT/shared/pb_data" "$old_dir" || die "Не удалось сохранить текущий pb_data: $old_dir"
  if ! mv "$staged_dir/pb_data" "$INSTALL_ROOT/shared/pb_data"; then
    warn "Не удалось опубликовать восстановленные данные; возвращаю исходный pb_data."
    mv "$old_dir" "$INSTALL_ROOT/shared/pb_data" ||
      die "Не удалось вернуть $old_dir на место; требуется ручное восстановление."
    return 1
  fi
  # shellcheck disable=SC2034 # Результат читается вызывающим скриптом после возврата.
  RESTORED_PREVIOUS_DATA=$old_dir
  remove_temp_dir "$extract_dir"
  remove_temp_dir "$staged_dir"
}

restore_data_from_backup_isolated() (
  local archive=$1 safety_suffix=${2:-$(date +%Y%m%d-%H%M%S)}
  TRAPS_SETUP=0
  TEMP_DIRS=()
  setup_traps
  restore_data_from_backup "$archive" "$safety_suffix"
  printf '%s\n' "$RESTORED_PREVIOUS_DATA"
)

run_update_cutover_steps() {
  local step
  (( $# > 0 )) || die "Для cutover нужен хотя бы один упорядоченный шаг."
  for step in "$@"; do
    "$step"
  done
}

confirm_or_die() {
  local prompt=$1 assume_yes=${2:-0} answer
  (( assume_yes )) && return 0
  [[ -t 0 ]] || die "$prompt Повторите с --yes для неинтерактивного запуска."
  read -r -p "$prompt [y/N] " answer
  [[ $answer == y || $answer == Y ]] || die "Операция отменена."
}
