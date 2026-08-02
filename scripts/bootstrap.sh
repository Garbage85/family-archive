#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_URL=https://github.com/Garbage85/family-archive.git
readonly REPOSITORY_BRANCH=main
BOOTSTRAP_DIR=""

cleanup() {
  if [[ -n $BOOTSTRAP_DIR && -d $BOOTSTRAP_DIR ]]; then
    rm -rf -- "$BOOTSTRAP_DIR"
  fi
}

die() {
  printf 'ОШИБКА: %s\n' "$*" >&2
  exit 1
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ $(uname -s) == Linux ]] || die "Bootstrap поддерживает только Linux."
[[ -n ${BASH_VERSION:-} ]] || die "Bootstrap необходимо запускать через bash."
(( BASH_VERSINFO[0] >= 4 )) || die "Нужен Bash 4 или новее; установлен $BASH_VERSION."

command -v sudo >/dev/null 2>&1 || die "Не найдена команда sudo."
command -v curl >/dev/null 2>&1 || die "Не найдена команда curl."

if ! command -v git >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 ||
    die "Git не установлен, а apt-get недоступен. Установите git вручную."
  printf 'Git не найден; устанавливаю его через apt.\n' >&2
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends git
fi
command -v git >/dev/null 2>&1 || die "Git не найден после установки."

BOOTSTRAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/family-archive-bootstrap.XXXXXX")"
printf 'Клонирую Family Archive во временный каталог.\n' >&2
git clone --depth 1 --branch "$REPOSITORY_BRANCH" "$REPOSITORY_URL" \
  "$BOOTSTRAP_DIR/repository"

printf 'Запускаю штатный install-server.sh.\n' >&2
sudo -- "$BOOTSTRAP_DIR/repository/scripts/install-server.sh" "$@"
