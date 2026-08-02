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
EXPECTED_OWNER_GID=0
LEGACY_SERVICE_USER=""
LEGACY_SERVICE_GROUP=""
LEGACY_SERVICE_UID=""
LEGACY_SERVICE_GID=""
LEGACY_OWNERSHIP_DIAGNOSTIC=""
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
    EXPECTED_OWNER_UID=${FAMILY_ARCHIVE_BOOTSTRAP_EXPECTED_OWNER_UID:-$(id -u)}
    EXPECTED_OWNER_GID=${FAMILY_ARCHIVE_BOOTSTRAP_EXPECTED_OWNER_GID:-$(id -g)}
    [[ $EXPECTED_OWNER_UID =~ ^[0-9]+$ && $EXPECTED_OWNER_GID =~ ^[0-9]+$ ]] ||
      die "Некорректный ожидаемый owner в bootstrap test mode."
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

check_directory_mode() {
  local path=$1 mode permissions
  if [[ ! -d $path || -L $path ]]; then
    DETECTION_REASON="install root не является обычным каталогом: $path"
    return 1
  fi
  mode=$(stat -c '%a' "$path")
  if [[ ! $mode =~ ^[0-7]{3,4}$ ]]; then
    DETECTION_REASON="не удалось проверить права install root: $path"
    return 1
  fi
  permissions=$((8#$mode))
  if (( (permissions & 0022) != 0 )); then
    DETECTION_REASON="install root доступен на запись группе или остальным: $path (mode $mode)"
    return 1
  fi
}

check_strict_owner() {
  local path=$1 owner group
  owner=$(privileged_stat %u "$path")
  group=$(privileged_stat %g "$path")
  if (( owner != EXPECTED_OWNER_UID || group != EXPECTED_OWNER_GID )); then
    DETECTION_REASON="небезопасный владелец $path: uid=$owner gid=$group, ожидается $EXPECTED_OWNER_UID:$EXPECTED_OWNER_GID"
    return 1
  fi
}

trim_unit_value() {
  local destination_var=$1 trimmed=$2
  trimmed=${trimmed#"${trimmed%%[![:space:]]*}"}
  trimmed=${trimmed%"${trimmed##*[![:space:]]}"}
  printf -v "$destination_var" '%s' "$trimmed"
}

parse_single_unit_value() {
  local unit_text=$1 key=$2 destination_var=$3 required=${4:-1}
  local line value="" count=0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*${key}[[:space:]]*=(.*)$ ]] || continue
    trim_unit_value value "${BASH_REMATCH[1]}"
    count=$((count + 1))
  done <<< "$unit_text"
  if (( count > 1 )); then
    DETECTION_REASON="unit family-tree.service содержит несколько $key; безопасно определить effective-значение невозможно"
    return 1
  fi
  if (( required )) && (( count != 1 || ${#value} == 0 )); then
    DETECTION_REASON="unit family-tree.service содержит пустой или отсутствующий $key"
    return 1
  fi
  printf -v "$destination_var" '%s' "$value"
}

system_uid_min() {
  local uid_min
  if (( TEST_MODE )) && [[ -n ${FAMILY_ARCHIVE_BOOTSTRAP_TEST_UID_MIN:-} ]]; then
    uid_min=$FAMILY_ARCHIVE_BOOTSTRAP_TEST_UID_MIN
  else
    uid_min=$(awk '$1 == "UID_MIN" && $2 ~ /^[0-9]+$/ {print $2; exit}' /etc/login.defs 2>/dev/null || true)
    [[ -n $uid_min ]] || uid_min=1000
  fi
  [[ $uid_min =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$uid_min"
}

resolve_legacy_service_identity() {
  local unit_text dynamic_user effective_user effective_group effective_dynamic
  local passwd_entry uid_min group_entry
  local -a passwd_fields=() group_fields=()
  systemctl is-active --quiet family-tree.service || {
    DETECTION_REASON="существующий family-tree.service не active"
    return 1
  }
  unit_text=$(systemctl cat family-tree.service 2>/dev/null) || {
    DETECTION_REASON="systemd не смог прочитать существующий family-tree.service"
    return 1
  }
  parse_single_unit_value "$unit_text" User LEGACY_SERVICE_USER || return 1
  parse_single_unit_value "$unit_text" Group LEGACY_SERVICE_GROUP || return 1
  parse_single_unit_value "$unit_text" DynamicUser dynamic_user 0 || return 1
  [[ ${dynamic_user,,} != yes && ${dynamic_user,,} != true && ${dynamic_user:-0} != 1 ]] || {
    DETECTION_REASON="unit family-tree.service использует DynamicUser и не имеет постоянного безопасного владельца"
    return 1
  }
  [[ $LEGACY_SERVICE_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || {
    DETECTION_REASON="unit family-tree.service содержит неизвестный или небезопасный User=$LEGACY_SERVICE_USER"
    return 1
  }
  [[ $LEGACY_SERVICE_GROUP =~ ^[a-z_][a-z0-9_-]*$ ]] || {
    DETECTION_REASON="unit family-tree.service содержит неизвестный или небезопасный Group=$LEGACY_SERVICE_GROUP"
    return 1
  }
  effective_user=$(systemctl show family-tree.service --property=User --value 2>/dev/null || true)
  effective_group=$(systemctl show family-tree.service --property=Group --value 2>/dev/null || true)
  effective_dynamic=$(systemctl show family-tree.service --property=DynamicUser --value 2>/dev/null || true)
  [[ $effective_user == "$LEGACY_SERVICE_USER" && $effective_group == "$LEGACY_SERVICE_GROUP" ]] || {
    DETECTION_REASON="effective User/Group family-tree.service не совпадают с безопасно разобранным unit"
    return 1
  }
  [[ ${effective_dynamic,,} != yes && ${effective_dynamic,,} != true && ${effective_dynamic:-0} != 1 ]] || {
    DETECTION_REASON="effective family-tree.service использует DynamicUser"
    return 1
  }
  passwd_entry=$(getent passwd "$LEGACY_SERVICE_USER" 2>/dev/null || true)
  [[ -n $passwd_entry && $passwd_entry != *$'\n'* ]] || {
    DETECTION_REASON="User=$LEGACY_SERVICE_USER из unit отсутствует в passwd"
    return 1
  }
  IFS=: read -r -a passwd_fields <<< "$passwd_entry"
  LEGACY_SERVICE_UID=${passwd_fields[2]:-}
  LEGACY_SERVICE_GID=${passwd_fields[3]:-}
  [[ ${passwd_fields[0]:-} == "$LEGACY_SERVICE_USER" && $LEGACY_SERVICE_UID =~ ^[0-9]+$ &&
    $LEGACY_SERVICE_GID =~ ^[0-9]+$ ]] || {
    DETECTION_REASON="не удалось однозначно определить uid/gid User=$LEGACY_SERVICE_USER"
    return 1
  }
  uid_min=$(system_uid_min) || {
    DETECTION_REASON="не удалось определить границу системных uid"
    return 1
  }
  (( LEGACY_SERVICE_UID > 0 && LEGACY_SERVICE_UID < uid_min )) || {
    DETECTION_REASON="User=$LEGACY_SERVICE_USER (uid=$LEGACY_SERVICE_UID) не является системным"
    return 1
  }
  group_entry=$(getent group "$LEGACY_SERVICE_GROUP" 2>/dev/null || true)
  [[ -n $group_entry && $group_entry != *$'\n'* ]] || {
    DETECTION_REASON="Group=$LEGACY_SERVICE_GROUP из unit отсутствует"
    return 1
  }
  IFS=: read -r -a group_fields <<< "$group_entry"
  LEGACY_SERVICE_GID=${group_fields[2]:-}
  [[ ${group_fields[0]:-} == "$LEGACY_SERVICE_GROUP" && $LEGACY_SERVICE_GID =~ ^[0-9]+$ ]] || {
    DETECTION_REASON="не удалось однозначно определить gid Group=$LEGACY_SERVICE_GROUP"
    return 1
  }
}

check_legacy_ownership() {
  local root_owner pocketbase_owner pocketbase_mode permissions path owner mode unsafe_path
  resolve_legacy_service_identity || return 1
  root_owner=$(sudo -- stat -c '%u' "$INSTALL_ROOT") || {
    DETECTION_REASON="не удалось проверить владельца legacy-root через sudo"
    return 1
  }
  if (( root_owner != 0 && root_owner != LEGACY_SERVICE_UID )); then
    DETECTION_REASON="legacy-root принадлежит uid=$root_owner, не связанному с User=$LEGACY_SERVICE_USER (uid=$LEGACY_SERVICE_UID)"
    return 1
  fi
  pocketbase_owner=$(sudo -- stat -c '%u' "$INSTALL_ROOT/pocketbase") || {
    DETECTION_REASON="не удалось проверить владельца legacy pocketbase через sudo"
    return 1
  }
  pocketbase_mode=$(sudo -- stat -c '%a' "$INSTALL_ROOT/pocketbase") || {
    DETECTION_REASON="не удалось проверить права legacy pocketbase через sudo"
    return 1
  }
  [[ $pocketbase_mode =~ ^[0-7]{3,4}$ ]] || {
    DETECTION_REASON="не удалось проверить права legacy pocketbase"
    return 1
  }
  permissions=$((8#$pocketbase_mode))
  if (( pocketbase_owner != 0 && pocketbase_owner != LEGACY_SERVICE_UID )); then
    DETECTION_REASON="legacy pocketbase принадлежит постороннему uid=$pocketbase_owner"
    return 1
  fi
  if (( (permissions & 0022) != 0 )); then
    DETECTION_REASON="legacy pocketbase доступен на запись группе или остальным (mode $pocketbase_mode)"
    return 1
  fi
  if (( TEST_MODE )); then
    while IFS= read -r -d '' path; do
      owner=$(stat -c '%u' "$path")
      mode=$(stat -c '%a' "$path")
      [[ $mode =~ ^[0-7]{3,4}$ ]] || {
        DETECTION_REASON="не удалось проверить права файла базы: $path"
        return 1
      }
      permissions=$((8#$mode))
      if (( owner != LEGACY_SERVICE_UID )); then
        DETECTION_REASON="небезопасный владелец файла базы $path: uid=$owner, ожидается User=$LEGACY_SERVICE_USER (uid=$LEGACY_SERVICE_UID)"
        return 1
      fi
      if (( (permissions & 0002) != 0 )); then
        DETECTION_REASON="файл базы доступен на запись остальным: $path (mode $mode)"
        return 1
      fi
    done < <(find "$INSTALL_ROOT/pb_data" -xdev -print0)
  else
    unsafe_path=$(sudo -- find "$INSTALL_ROOT/pb_data" -xdev ! -uid "$LEGACY_SERVICE_UID" -print -quit) || {
      DETECTION_REASON="не удалось полностью проверить владельцев legacy pb_data через sudo"
      return 1
    }
    if [[ -n $unsafe_path ]]; then
      owner=$(sudo -- stat -c '%u' "$unsafe_path" 2>/dev/null || printf unknown)
      DETECTION_REASON="небезопасный владелец файла базы $unsafe_path: uid=$owner, ожидается User=$LEGACY_SERVICE_USER (uid=$LEGACY_SERVICE_UID)"
      return 1
    fi
    unsafe_path=$(sudo -- find "$INSTALL_ROOT/pb_data" -xdev -perm -0002 -print -quit) || {
      DETECTION_REASON="не удалось полностью проверить права legacy pb_data через sudo"
      return 1
    }
    if [[ -n $unsafe_path ]]; then
      mode=$(sudo -- stat -c '%a' "$unsafe_path" 2>/dev/null || printf unknown)
      DETECTION_REASON="файл базы доступен на запись остальным: $unsafe_path (mode $mode)"
      return 1
    fi
  fi
  LEGACY_OWNERSHIP_DIAGNOSTIC="legacy owner uid=$root_owner разрешён; service=$LEGACY_SERVICE_USER:$LEGACY_SERVICE_GROUP ($LEGACY_SERVICE_UID:$LEGACY_SERVICE_GID); pocketbase uid=$pocketbase_owner (root или service — безопасно); pb_data принадлежит service"
}

check_release_config_security() {
  local config=$INSTALL_ROOT/shared/deployment.env owner group mode
  owner=$(privileged_stat %u "$config") || {
    DETECTION_REASON="не удалось проверить владельца deployment.env через sudo"
    return 1
  }
  group=$(privileged_stat %g "$config") || {
    DETECTION_REASON="не удалось проверить группу deployment.env через sudo"
    return 1
  }
  mode=$(privileged_stat %a "$config") || {
    DETECTION_REASON="не удалось проверить права deployment.env через sudo"
    return 1
  }
  if (( owner != EXPECTED_OWNER_UID || group != EXPECTED_OWNER_GID )) || [[ $mode != 600 ]]; then
    DETECTION_REASON="deployment.env должен принадлежать root:root и иметь mode 600: uid=$owner gid=$group mode=$mode"
    return 1
  fi
}

check_release_tree_ownership() {
  local unsafe_path
  validate_privileged_path_string "$INSTALL_ROOT/app" || return 1
  validate_privileged_path_string "$INSTALL_ROOT/releases" || return 1
  unsafe_path=$(sudo -- find "$INSTALL_ROOT/app" "$INSTALL_ROOT/releases" -xdev \
    \( ! -uid "$EXPECTED_OWNER_UID" -o ! -gid "$EXPECTED_OWNER_GID" \) \
    -print -quit) || {
    DETECTION_REASON="не удалось полностью проверить владельцев release-структуры через sudo"
    return 1
  }
  if [[ -n $unsafe_path ]]; then
    validate_privileged_path_string "$unsafe_path" || {
      DETECTION_REASON="find вернул небезопасный путь release-структуры"
      return 1
    }
    DETECTION_REASON="release-структура содержит объект не от root:root: $unsafe_path (owner=$(privileged_stat %u:%g "$unsafe_path" 2>/dev/null || printf unknown))"
    return 1
  fi
}

regular_directory() {
  [[ -d $1 && ! -L $1 ]]
}

validate_privileged_path_string() {
  local path=$1
  [[ -n $path && $path == /* && $path != / && $path != */ && $path != *//* ]] || return 1
  [[ $path =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ ! $path =~ (^|/)\.\.?(/|$) ]]
}

privileged_path_exists() {
  local path=$1
  validate_privileged_path_string "$path" || return 2
  sudo -- test -L "$path" || sudo -- test -e "$path"
}

privileged_is_symlink() {
  local path=$1
  validate_privileged_path_string "$path" || return 2
  sudo -- test -L "$path"
}

privileged_regular_directory() {
  local path=$1
  validate_privileged_path_string "$path" || return 2
  sudo -- test ! -L "$path" && sudo -- test -d "$path"
}

privileged_regular_file() {
  local path=$1
  validate_privileged_path_string "$path" || return 2
  sudo -- test ! -L "$path" && sudo -- test -f "$path"
}

privileged_executable_file() {
  local path=$1
  privileged_regular_file "$path" && sudo -- test -x "$path"
}

privileged_stat() {
  local format=$1 path=$2
  validate_privileged_path_string "$path" || return 2
  case "$format" in
    %u|%g|%a|%u:%g) ;;
    *) return 2 ;;
  esac
  sudo -- stat -c "$format" "$path"
}

privileged_canonical_symlink_target() {
  local path=$1 target
  validate_privileged_path_string "$path" || return 2
  privileged_is_symlink "$path" || return 1
  target=$(sudo -- readlink -f -- "$path" 2>/dev/null) || return 1
  validate_privileged_path_string "$target" || return 1
  printf '%s\n' "$target"
}

ensure_sudo_access() {
  if ! sudo -v; then
    die "Не удалось получить доступ через sudo. Bootstrap требует sudo для безопасной проверки защищённой release-структуры; запустите из интерактивного терминала или настройте разрешённый sudo."
  fi
}

path_exists_or_is_symlink() {
  [[ -e $1 || -L $1 ]]
}

legacy_layout_markers_present() {
  path_exists_or_is_symlink "$INSTALL_ROOT/pocketbase" ||
    path_exists_or_is_symlink "$INSTALL_ROOT/pb_data"
}

release_layout_markers_present() {
  privileged_path_exists "$INSTALL_ROOT/current" ||
    privileged_path_exists "$INSTALL_ROOT/releases" ||
    privileged_path_exists "$INSTALL_ROOT/shared" ||
    privileged_path_exists "$INSTALL_ROOT/app" ||
    privileged_path_exists "$INSTALL_ROOT/app/repository.git"
}

validate_legacy_layout() {
  if [[ ! -f $INSTALL_ROOT/pocketbase || -L $INSTALL_ROOT/pocketbase ||
    ! -x $INSTALL_ROOT/pocketbase ]]; then
    DETECTION_REASON="legacy pocketbase отсутствует, не является обычным исполняемым файлом или является symlink: $INSTALL_ROOT/pocketbase"
    return 1
  fi
  if ! regular_directory "$INSTALL_ROOT/pb_data"; then
    DETECTION_REASON="legacy pb_data отсутствует или не является обычным каталогом: $INSTALL_ROOT/pb_data"
    return 1
  fi
  check_legacy_ownership
}

check_release_directory_permissions() {
  local path mode permissions owner group service_user=familytree service_group=familytree
  local passwd_entry group_entry service_uid service_gid data_path data_owner data_group config_path
  config_path="$INSTALL_ROOT/shared/deployment.env"
  for path in "$INSTALL_ROOT/shared" "$INSTALL_ROOT/shared/pb_data" "$config_path"; do
    validate_privileged_path_string "$path" || {
      DETECTION_REASON="небезопасная строка пути release-структуры: $path"
      return 1
    }
  done
  for path in "$INSTALL_ROOT/shared" "$INSTALL_ROOT/shared/pb_data"; do
    mode=$(privileged_stat %a "$path") || {
      DETECTION_REASON="не удалось проверить права release-каталога: $path"
      return 1
    }
    [[ $mode =~ ^[0-7]{3,4}$ ]] || {
      DETECTION_REASON="некорректные права release-каталога: $path"
      return 1
    }
    permissions=$((8#$mode))
    if (( (permissions & 0002) != 0 )); then
      DETECTION_REASON="release-каталог доступен на запись остальным: $path (mode $mode)"
      return 1
    fi
  done
  owner=$(privileged_stat %u "$INSTALL_ROOT/shared") || {
    DETECTION_REASON="не удалось проверить владельца shared: $INSTALL_ROOT/shared"
    return 1
  }
  if (( owner != EXPECTED_OWNER_UID )); then
    DETECTION_REASON="небезопасный владелец shared: uid=$owner, ожидается $EXPECTED_OWNER_UID"
    return 1
  fi
  service_user=$(sudo -- sed -n 's/^SERVICE_USER=//p' "$config_path") || {
    DETECTION_REASON="не удалось прочитать SERVICE_USER из deployment.env через sudo"
    return 1
  }
  service_user=${service_user:-familytree}
  service_group=$(sudo -- sed -n 's/^SERVICE_GROUP=//p' "$config_path") || {
    DETECTION_REASON="не удалось прочитать SERVICE_GROUP из deployment.env через sudo"
    return 1
  }
  service_group=${service_group:-familytree}
  [[ $service_user =~ ^[a-z_][a-z0-9_-]*$ ]] || {
    DETECTION_REASON="deployment.env содержит небезопасный SERVICE_USER"
    return 1
  }
  [[ $service_group =~ ^[a-z_][a-z0-9_-]*$ ]] || {
    DETECTION_REASON="deployment.env содержит небезопасный SERVICE_GROUP"
    return 1
  }
  passwd_entry=$(sudo -- getent passwd "$service_user" 2>/dev/null || true)
  [[ -n $passwd_entry && $passwd_entry != *$'\n'* ]] || {
    DETECTION_REASON="SERVICE_USER=$service_user из deployment.env отсутствует"
    return 1
  }
  IFS=: read -r _ _ service_uid _ <<< "$passwd_entry"
  [[ $service_uid =~ ^[0-9]+$ ]] || {
    DETECTION_REASON="не удалось определить uid SERVICE_USER=$service_user"
    return 1
  }
  group_entry=$(sudo -- getent group "$service_group" 2>/dev/null || true)
  [[ -n $group_entry && $group_entry != *$'\n'* ]] || {
    DETECTION_REASON="SERVICE_GROUP=$service_group из deployment.env отсутствует"
    return 1
  }
  IFS=: read -r _ _ service_gid _ <<< "$group_entry"
  [[ $service_gid =~ ^[0-9]+$ ]] || {
    DETECTION_REASON="не удалось определить gid SERVICE_GROUP=$service_group"
    return 1
  }
  group=$(privileged_stat %g "$INSTALL_ROOT/shared") || {
    DETECTION_REASON="не удалось проверить группу shared"
    return 1
  }
  if (( group != service_gid )); then
    DETECTION_REASON="shared принадлежит небезопасной группе gid=$group, ожидается $service_gid"
    return 1
  fi
  data_path="$INSTALL_ROOT/shared/pb_data"
  data_owner=$(privileged_stat %u "$data_path") || {
    DETECTION_REASON="не удалось проверить владельца shared/pb_data"
    return 1
  }
  data_group=$(privileged_stat %g "$data_path") || {
    DETECTION_REASON="не удалось проверить группу shared/pb_data"
    return 1
  }
  if (( data_owner != service_uid )); then
    DETECTION_REASON="shared/pb_data принадлежит uid=$data_owner, ожидается SERVICE_USER=$service_user (uid=$service_uid)"
    return 1
  fi
  if (( data_group != service_gid )); then
    DETECTION_REASON="shared/pb_data принадлежит gid=$data_group, ожидается SERVICE_GROUP=$service_group (gid=$service_gid)"
    return 1
  fi
  if ! sudo -- runuser -u "$service_user" -- test -r "$data_path"; then
    DETECTION_REASON="SERVICE_USER=$service_user не может читать shared/pb_data"
    return 1
  fi
  if ! sudo -- runuser -u "$service_user" -- test -w "$data_path"; then
    DETECTION_REASON="SERVICE_USER=$service_user не может писать в shared/pb_data"
    return 1
  fi
}

check_release_symlink_targets() {
  local base path target
  for base in "$1" "$INSTALL_ROOT/app/repository.git"; do
    validate_privileged_path_string "$base" || {
      DETECTION_REASON="небезопасная строка base path release-структуры"
      return 1
    }
    sudo -- find "$base" -xdev -type l -print0 >/dev/null || {
      DETECTION_REASON="не удалось проверить symlink targets release-структуры: $base"
      return 1
    }
    while IFS= read -r -d '' path; do
      validate_privileged_path_string "$path" || {
        DETECTION_REASON="find вернул небезопасный symlink path release-структуры"
        return 1
      }
      target=$(privileged_canonical_symlink_target "$path" 2>/dev/null || true)
      if [[ $base == "$1" && $path == "$base/pb_data" &&
        $target == "$INSTALL_ROOT/shared/pb_data" ]]; then
        continue
      fi
      if [[ -z $target || $target != "$base/"* ]]; then
        DETECTION_REASON="release-структура содержит symlink с небезопасным target: $path -> ${target:-dangling}"
        return 1
      fi
    done < <(sudo -- find "$base" -xdev -type l -print0)
  done
}

validate_bare_repository() {
  local repository="$INSTALL_ROOT/app/repository.git" bare
  if ! privileged_regular_directory "$repository"; then
    DETECTION_REASON="bare Git-репозиторий отсутствует или имеет небезопасный тип: $repository"
    return 1
  fi
  bare=$(sudo -- git --git-dir="$repository" rev-parse --is-bare-repository 2>/dev/null || true)
  if [[ $bare != true ]]; then
    DETECTION_REASON="путь не является bare Git-репозиторием: $repository"
    return 1
  fi
}

validate_release_layout() {
  local current="$INSTALL_ROOT/current" releases="$INSTALL_ROOT/releases"
  local current_target releases_target pocketbase_mode pocketbase_permissions

  privileged_is_symlink "$current" || {
    DETECTION_REASON="release current отсутствует или не является symlink: $current"
    return 1
  }
  privileged_regular_directory "$releases" || {
    DETECTION_REASON="releases отсутствует или не является обычным каталогом: $releases"
    return 1
  }
  releases_target=$releases
  current_target=$(privileged_canonical_symlink_target "$current" 2>/dev/null || true)
  if [[ -z $current_target ]]; then
    DETECTION_REASON="current указывает на отсутствующий target: $(sudo -- readlink "$current" 2>/dev/null || printf unreadable)"
    return 1
  fi
  if [[ $current_target != "$releases_target/"* ]]; then
    DETECTION_REASON="канонический target current находится вне releases: $current_target"
    return 1
  fi
  privileged_regular_directory "$current_target" || {
    DETECTION_REASON="target current не является обычным каталогом: $current_target"
    return 1
  }
  if ! privileged_executable_file "$current_target/pocketbase"; then
    DETECTION_REASON="release pocketbase отсутствует, не является обычным исполняемым файлом или является symlink: $current_target/pocketbase"
    return 1
  fi
  pocketbase_mode=$(privileged_stat %a "$current_target/pocketbase") || {
    DETECTION_REASON="не удалось проверить права release pocketbase"
    return 1
  }
  [[ $pocketbase_mode =~ ^[0-7]{3,4}$ ]] || {
    DETECTION_REASON="некорректные права release pocketbase"
    return 1
  }
  pocketbase_permissions=$((8#$pocketbase_mode))
  if (( (pocketbase_permissions & 0022) != 0 )); then
    DETECTION_REASON="release pocketbase доступен на запись группе или остальным (mode $pocketbase_mode)"
    return 1
  fi
  privileged_regular_directory "$current_target/pb_public" || {
    DETECTION_REASON="release pb_public отсутствует или не является обычным каталогом: $current_target/pb_public"
    return 1
  }
  privileged_regular_directory "$current_target/pb_migrations" || {
    DETECTION_REASON="release pb_migrations отсутствует или не является обычным каталогом: $current_target/pb_migrations"
    return 1
  }
  privileged_regular_directory "$INSTALL_ROOT/shared" || {
    DETECTION_REASON="shared отсутствует или не является обычным каталогом: $INSTALL_ROOT/shared"
    return 1
  }
  validate_privileged_path_string "$INSTALL_ROOT/shared/pb_data" || {
    DETECTION_REASON="небезопасная строка пути shared/pb_data"
    return 1
  }
  sudo -- test ! -L "$INSTALL_ROOT/shared/pb_data" || {
    DETECTION_REASON="shared/pb_data не должен быть symlink: $INSTALL_ROOT/shared/pb_data"
    return 1
  }
  sudo -- test -d "$INSTALL_ROOT/shared/pb_data" || {
    DETECTION_REASON="shared/pb_data отсутствует или не является каталогом: $INSTALL_ROOT/shared/pb_data"
    return 1
  }
  if ! privileged_regular_file "$INSTALL_ROOT/shared/deployment.env"; then
    DETECTION_REASON="deployment.env отсутствует или не является обычным файлом: $INSTALL_ROOT/shared/deployment.env"
    return 1
  fi
  privileged_regular_directory "$INSTALL_ROOT/app" || {
    DETECTION_REASON="app отсутствует или не является обычным каталогом: $INSTALL_ROOT/app"
    return 1
  }
  validate_bare_repository || return 1
  check_release_config_security || return 1
  check_release_directory_permissions || return 1
  check_release_symlink_targets "$current_target" || return 1
  check_release_tree_ownership || return 1
  check_strict_owner "$INSTALL_ROOT" || return 1
  DETECTION_REASON="current -> $current_target"
}

set_detection_error() {
  DETECTED_MODE=error
  DETECTION_REASON=$1
}

detect_installation() {
  local has_legacy=0 has_release=0

  if [[ ! -e $INSTALL_ROOT && ! -L $INSTALL_ROOT ]]; then
    DETECTED_MODE=install
    DETECTION_REASON='install root отсутствует'
    return
  fi
  [[ ! -L $INSTALL_ROOT ]] || { set_detection_error 'install root является symlink'; return; }
  if ! check_directory_mode "$INSTALL_ROOT"; then
    set_detection_error "$DETECTION_REASON"
    return
  fi

  legacy_layout_markers_present && has_legacy=1
  release_layout_markers_present && has_release=1

  if (( has_legacy && has_release )); then
    set_detection_error 'одновременно присутствуют legacy- и release-маркеры'
    return
  fi
  if (( has_legacy )); then
    if ! validate_legacy_layout; then
      set_detection_error "$DETECTION_REASON"
      return
    fi
    DETECTED_MODE=migrate
    DETECTION_REASON='найдены обычные pocketbase и pb_data, release-маркеры отсутствуют'
    return
  fi
  if (( has_release )); then
    if ! validate_release_layout; then
      set_detection_error "$DETECTION_REASON"
      return
    fi
    DETECTED_MODE=update
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
  if privileged_is_symlink "$INSTALL_ROOT/current"; then
    current_value="symlink -> $(sudo -- readlink "$INSTALL_ROOT/current" 2>/dev/null || printf unreadable)"
  elif privileged_path_exists "$INSTALL_ROOT/current"; then
    current_value="обычный файл/каталог"
  fi
  printf 'Диагностика bootstrap:\n' >&2
  printf '  install-root: %s\n  current: %s\n' "$INSTALL_ROOT" "$current_value" >&2
  printf '  legacy pocketbase marker: %s\n  legacy pb_data marker: %s\n  releases: %s\n  shared: %s\n' \
    "$([[ -e $INSTALL_ROOT/pocketbase || -L $INSTALL_ROOT/pocketbase ]] && printf present || printf absent)" \
    "$([[ -e $INSTALL_ROOT/pb_data || -L $INSTALL_ROOT/pb_data ]] && printf present || printf absent)" \
    "$(privileged_path_exists "$INSTALL_ROOT/releases" && printf present || printf absent)" \
    "$(privileged_path_exists "$INSTALL_ROOT/shared" && printf present || printf absent)" >&2
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
command -v sudo >/dev/null 2>&1 ||
  die "Команда sudo недоступна. Она требуется для безопасной проверки защищённой release-структуры."
for required_command in curl git realpath stat find readlink dirname env mktemp rm systemctl getent awk id runuser; do
  command -v "$required_command" >/dev/null 2>&1 || die "Не найдена обязательная команда: $required_command"
done
validate_absolute_install_root
ensure_sudo_access

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
    printf 'Проверка владельцев: %s\n' "$LEGACY_OWNERSHIP_DIAGNOSTIC" >&2
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
