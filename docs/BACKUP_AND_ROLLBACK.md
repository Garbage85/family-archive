# Backup и rollback

## Создание backup

```bash
sudo /opt/family-tree/current/scripts/backup-server.sh
```

Сервис останавливается только на время `rsync` согласованного снимка `pb_data` во
временный `mktemp`-каталог и сразу запускается снова. Сжатие и проверка tar выполняются
уже после возобновления работы.

Во время update используется специальный offline-режим: updater сначала сам
останавливает сервис, затем создаёт backup и не запускает старую версию между снимком
и миграцией. Поэтому rollback миграции всегда опирается на точное предмиграционное
состояние, а не на более ранний online-снимок.

Архив содержит только:

- `pb_data`;
- `pb_migrations` активного release;
- `metadata.json` с commit, ref, датой и версией PocketBase;
- systemd unit;
- несекретную deployment-конфигурацию.

`node_modules`, исходники и `pb_public` не архивируются. Имя имеет вид
`family-archive-YYYYMMDD-HHMMSS-COMMIT.tar.gz`; рядом создаётся `.sha256`. Архив
публикуется атомарным rename только после проверки, имеет режим `0600`, а каталог
backup — `0700`.

Опции:

```bash
sudo ./scripts/backup-server.sh --output /mnt/secure-backups --keep 14
sudo ./scripts/backup-server.sh --output /tmp/manual.tar.gz --quiet
```

`--no-prune` отключает retention для одного запуска; rollback использует эту опцию
для аварийной копии, чтобы не удалить выбранный архив восстановления.

Retention запускается только после успешного создания и проверки нового архива.
Храните дополнительную копию архива и checksum off-site; скрипт намеренно не
настраивает внешнее хранилище и не содержит credentials.

## Список доступных состояний

```bash
sudo ./scripts/rollback-server.sh --list
```

Текущий release отмечен `*`.

## Rollback к release

```bash
sudo ./scripts/rollback-server.sh --previous
sudo ./scripts/rollback-server.sh --release 0123456789ab
sudo ./scripts/rollback-server.sh --release 20260802-120000-0123456789ab --yes
```

Rollback только к старому коду не меняет `pb_data` и выводит предупреждение: уже
применённая схема может быть несовместима со старым бинарником или frontend.

## Явное восстановление данных

```bash
sudo ./scripts/rollback-server.sh \
  --backup family-archive-20260802-120000-0123456789ab.tar.gz \
  --restore-data
```

Можно одновременно выбрать соответствующий release через `--release`. Без
`--restore-data` архив никогда не распаковывается в production.

Перед любой изменяющей операцией rollback создаётся ещё один аварийный backup.
Входной архив полностью проверяется до остановки сервиса: запрещены абсолютные пути,
`../`, обратные слеши, symlink, hardlink и специальные файлы. Распаковка происходит
в `mktemp`, затем подготовленный `pb_data` переключается; предыдущий каталог данных
сохраняется как `shared/pb_data.before-restore-*`.

Если health check не проходит, скрипт возвращает исходный release и восстанавливает
данные из аварийного backup. Не удаляйте аварийные backup и сохранённые каталоги до
полной проверки приложения.

## Проверка backup вручную

```bash
cd /opt/family-tree/backups
sha256sum --check family-archive-....tar.gz.sha256
tar -tzf family-archive-....tar.gz
```

Не извлекайте непроверенный архив от root напрямую в `/opt/family-tree`.
