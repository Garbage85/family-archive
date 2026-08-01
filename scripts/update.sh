#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${EUID} -ne 0 ]]; then echo "Запустите через sudo."; exit 1; fi
cd /opt/family-tree/frontend
npm install --no-audit --no-fund
npm run check
npm test
npm run build
chown -R familytree:familytree /opt/family-tree
systemctl restart family-tree
echo "Интерфейс обновлён."
