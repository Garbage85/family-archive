# Обновление Family Archive

Обновление никогда не выполняет `git pull` в активном release. Новый commit
выгружается через зеркало в `/opt/family-tree/app/repository.git`, проверяется и
собирается во временном каталоге. Только готовый release становится кандидатом на
переключение.

## Обычное обновление main

```bash
sudo /opt/family-tree/current/scripts/update-server.sh
```

Проверка без persistent-изменений:

```bash
sudo /opt/family-tree/current/scripts/update-server.sh --dry-run
```

Выбор источника:

```bash
sudo /opt/family-tree/current/scripts/update-server.sh --branch main
sudo /opt/family-tree/current/scripts/update-server.sh --ref v0.4.0
sudo /opt/family-tree/current/scripts/update-server.sh \
  --ref 0123456789abcdef0123456789abcdef01234567
```

Для raw commit используйте полный 40-символьный SHA. Одновременные `--branch` и
`--ref` запрещены.

Дополнительные опции:

- `--keep-releases N` — число сохраняемых releases;
- `--skip-backup` — явный отказ от backup. Опция автоматически запрещается, если
  набор миграций изменился;
- `--config FILE` — альтернативная deployment-конфигурация.

## Порядок обновления

1. Проверяются active service, lock и свободное место.
2. Определяются текущий и целевой commit.
3. Пока production работает, выполняются `npm ci`, lint, format check, syntax check,
   тесты, build и проверка синтаксиса миграций.
4. Скачивается закреплённый PocketBase и проверяется SHA-256.
5. Создаётся новый неизменяемый release.
6. Сервис останавливается, и только после остановки создаётся проверенный offline
   backup точного предмиграционного состояния.
7. Применяются миграции, `current` переключается атомарно, новый release запускается.
8. Проверяются systemd, слушающий порт, HTTP 200 и `/api/health`.
9. Только после успеха удаляются лишние старые releases.

Install, update, rollback и standalone-backup не могут одновременно менять состояние:
операции блокируются через `flock` на `shared/update.lock`.

## Автоматический rollback ошибки

Если ошибка возникает после начала production-фазы, скрипт возвращает исходный
symlink. Когда набор миграций отличался, `pb_data` восстанавливается именно из
offline backup, созданного после остановки сервиса непосредственно перед миграцией,
а изменённое состояние сохраняется рядом как
`pb_data.before-restore-failed-update-*`. После этого запускается предыдущий release
и повторяется health check.

При `--skip-backup` обновление допустимо только без изменения миграций. Это снижает
защиту от других ошибок и не рекомендуется.

## Обновление PocketBase

Версия и SHA-256 закреплены в deployment-конфигурации. Чтобы обновить PocketBase,
сначала возьмите hashes из официального `checksums.txt`, обновите
`/etc/family-tree/deployment.env`, затем выполните обычное обновление приложения.
Не используйте встроенную команду самообновления PocketBase: бинарник является частью
release и должен проходить тот же проверяемый процесс.

## Диагностика

```bash
sudo /opt/family-tree/current/scripts/status-server.sh
sudo /opt/family-tree/current/scripts/status-server.sh --json --no-logs
```

Даже при отсутствии обновления status обращается к GitHub только read-only через
`git ls-remote`. Ошибка сети отображается как `unknown` и не меняет установку.
