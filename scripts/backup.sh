#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${EUID} -ne 0 ]]; then echo "Запустите через sudo."; exit 1; fi
DEST="/var/backups/family-tree"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
mkdir -p "$DEST"
systemctl stop family-tree
trap 'systemctl start family-tree' EXIT
tar -C /opt/family-tree -czf "$DEST/family-tree_${STAMP}.tar.gz" pb_data pb_migrations pb_public frontend
find "$DEST" -type f -name 'family-tree_*.tar.gz' -mtime +30 -delete
systemctl start family-tree
trap - EXIT
echo "Резервная копия: $DEST/family-tree_${STAMP}.tar.gz"
