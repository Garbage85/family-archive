#!/usr/bin/env bash
set -Eeuo pipefail

PB_VERSION="0.39.10"
INSTALL_DIR="/opt/family-tree"
SERVICE_NAME="family-tree"
PORT="${PB_PORT:-8090}"

if [[ ${EUID} -ne 0 ]]; then
  echo "Запустите: sudo ./scripts/install.sh"
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/8] Устанавливаю системные пакеты"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl unzip jq ca-certificates nodejs npm rsync

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( NODE_MAJOR < 18 )); then
  echo "Нужен Node.js 18 или новее. Сейчас установлен $(node --version)."
  echo "Обновите Node.js и повторите запуск. Древо не обязано расти на палеозойском JavaScript."
  exit 1
fi

echo "[2/8] Копирую проект"
mkdir -p "$INSTALL_DIR"
rsync -a --delete \
  --exclude pb_data \
  --exclude pocketbase \
  --exclude node_modules \
  "$SOURCE_DIR/" "$INSTALL_DIR/"

node --check "$INSTALL_DIR/pb_migrations/1785456000_initial_family_tree.js"

cd "$INSTALL_DIR/frontend"
echo "[3/8] Собираю интерфейс"
npm ci --no-audit --no-fund
npm run check
npm test
npm run build

case "$(uname -m)" in
  aarch64|arm64) PB_ARCH="linux_arm64" ;;
  armv7l|armv6l) PB_ARCH="linux_armv7" ;;
  x86_64|amd64) PB_ARCH="linux_amd64" ;;
  *) echo "Неизвестная архитектура: $(uname -m)"; exit 1 ;;
esac

echo "[4/8] Скачиваю PocketBase ${PB_VERSION} (${PB_ARCH})"
TMP_ZIP="$(mktemp --suffix=.zip)"
curl -fL "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_${PB_ARCH}.zip" -o "$TMP_ZIP"
unzip -o "$TMP_ZIP" pocketbase -d "$INSTALL_DIR"
rm -f "$TMP_ZIP"
chmod 0755 "$INSTALL_DIR/pocketbase"

if ! id familytree >/dev/null 2>&1; then
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin familytree
fi
mkdir -p "$INSTALL_DIR/pb_data" "$INSTALL_DIR/pb_migrations"
chown -R familytree:familytree "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "[5/8] Применяю структуру базы"
if ! MIGRATION_OUTPUT="$(sudo -u familytree "$INSTALL_DIR/pocketbase" migrate up --dir "$INSTALL_DIR/pb_data" 2>&1)"; then
  printf '%s\n' "$MIGRATION_OUTPUT"
  exit 1
fi
printf '%s\n' "$MIGRATION_OUTPUT"
if grep -q '^Error:' <<<"$MIGRATION_OUTPUT"; then
  echo "Migration failed. Installation stopped."
  exit 1
fi

echo "[6/8] Создаю учётные записи"
read -rp "Email администратора: " ADMIN_EMAIL
read -rp "Имя администратора [Алексей]: " ADMIN_NAME
ADMIN_NAME="${ADMIN_NAME:-Алексей}"
read -rsp "Пароль (минимум 10 символов): " ADMIN_PASSWORD
echo
if (( ${#ADMIN_PASSWORD} < 10 )); then
  echo "Пароль слишком короткий."
  exit 1
fi

# Суперпользователь нужен только для встроенной панели PocketBase.
if ! sudo -u familytree "$INSTALL_DIR/pocketbase" superuser create "$ADMIN_EMAIL" "$ADMIN_PASSWORD" --dir "$INSTALL_DIR/pb_data" 2>/dev/null; then
  echo "Суперпользователь уже существует или не был создан. Продолжаю."
fi

sed "s/--http=0.0.0.0:8090/--http=0.0.0.0:${PORT}/" \
  "$INSTALL_DIR/systemd/family-tree.service" > "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then break; fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
  echo "PocketBase не запустился. Последние сообщения службы:"
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
  exit 1
fi

echo "[7/8] Создаю администратора сайта"
AUTH_JSON="$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/collections/_superusers/auth-with-password" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg identity "$ADMIN_EMAIL" --arg password "$ADMIN_PASSWORD" '{identity:$identity,password:$password}')")"
TOKEN="$(jq -r '.token' <<<"$AUTH_JSON")"

USER_PAYLOAD="$(jq -n \
  --arg email "$ADMIN_EMAIL" \
  --arg password "$ADMIN_PASSWORD" \
  --arg name "$ADMIN_NAME" \
  '{email:$email,password:$password,passwordConfirm:$password,name:$name,role:"admin",emailVisibility:false}')"

HTTP_CODE="$(curl -sS -o /tmp/family-tree-user-response.json -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PORT}/api/collections/users/records" \
  -H "Authorization: ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "$USER_PAYLOAD")"
if [[ "$HTTP_CODE" != "200" ]]; then
  if grep -qi 'unique' /tmp/family-tree-user-response.json; then
    echo "Пользователь сайта уже существует."
  else
    echo "Не удалось создать пользователя сайта (HTTP ${HTTP_CODE}):"
    cat /tmp/family-tree-user-response.json
    exit 1
  fi
fi
rm -f /tmp/family-tree-user-response.json

mkdir -p /var/backups/family-tree
chmod 0700 /var/backups/family-tree

echo "[8/8] Готово"
echo
printf 'Сайт:        http://%s:%s/\n' "$(hostname -I | awk '{print $1}')" "$PORT"
printf 'Админка PB: http://%s:%s/_/\n' "$(hostname -I | awk '{print $1}')" "$PORT"
echo "Логин сайта: ${ADMIN_EMAIL}"
echo
systemctl --no-pager --full status "$SERVICE_NAME" || true
