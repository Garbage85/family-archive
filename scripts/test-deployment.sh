#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Проверка deployment-скриптов без доступа к production.

Использование:
  ./scripts/test-deployment.sh [--require-shellcheck]

Опции:
  --require-shellcheck  Завершиться с ошибкой, если shellcheck не установлен
  -h, --help            Показать справку
EOF
}

REQUIRE_SHELLCHECK=0
while (($#)); do
  case "$1" in
    --require-shellcheck) REQUIRE_SHELLCHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ОШИБКА: неизвестная опция: %s\n' "$1" >&2; exit 2 ;;
  esac
done

mapfile -t SHELL_FILES < <(find "$SCRIPT_DIR" -type f -name '*.sh' -print | sort)
printf 'Проверяю bash-синтаксис (%s файлов).\n' "${#SHELL_FILES[@]}"
for file in "${SHELL_FILES[@]}"; do
  bash -n "$file"
done

if command -v shellcheck >/dev/null 2>&1; then
  printf 'Запускаю shellcheck.\n'
  shellcheck -x "${SHELL_FILES[@]}"
elif (( REQUIRE_SHELLCHECK )); then
  printf 'ОШИБКА: shellcheck не установлен.\n' >&2
  exit 1
else
  printf 'ПРЕДУПРЕЖДЕНИЕ: shellcheck не установлен; проверка пропущена.\n' >&2
fi

printf 'Запускаю тесты чистых функций и архивов в mktemp.\n'
"$SCRIPT_DIR/tests/deployment-tests.sh"
