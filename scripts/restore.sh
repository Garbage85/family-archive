#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${EUID} -ne 0 ]]; then echo "Запустите через sudo."; exit 1; fi
ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Использование: sudo ./scripts/restore.sh /путь/к/family-tree_Дата.tar.gz"
  exit 1
fi
systemctl stop family-tree
trap 'systemctl start family-tree' EXIT
cp -a /opt/family-tree/pb_data "/opt/family-tree/pb_data.before-restore-$(date +%s)"
tar -C /opt/family-tree -xzf "$ARCHIVE"
chown -R familytree:familytree /opt/family-tree
systemctl start family-tree
trap - EXIT
echo "Восстановление завершено. Предыдущая pb_data сохранена рядом."
