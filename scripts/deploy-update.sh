#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${EUID} -ne 0 ]]; then echo "Запустите: sudo ./scripts/deploy-update.sh"; exit 1; fi
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/family-tree"

echo "[1/4] Копирую исходники интерфейса"
rsync -a --delete --exclude node_modules "$SOURCE_DIR/frontend/" "$INSTALL_DIR/frontend/"

echo "[2/4] Устанавливаю зависимости"
cd "$INSTALL_DIR/frontend"
npm ci --no-audit --no-fund

echo "[3/4] Проверяю и собираю"
npm run check
npm test
npm run build

echo "[4/4] Перезапускаю сайт"
chown -R familytree:familytree "$INSTALL_DIR"
systemctl restart family-tree
systemctl --no-pager --full status family-tree
echo "Обновление установлено. Откройте сайт с параметром ?v=020"
