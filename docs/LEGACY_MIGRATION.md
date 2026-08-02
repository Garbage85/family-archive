# Миграция legacy-установки

Первая рекомендуемая команда совпадает с установкой и обновлением:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh)
```

Bootstrap распознаёт legacy-layout, запускает прямой мигратор с `--dry-run`,
показывает план и запрашивает явное подтверждение. Для неинтерактивного запуска
добавьте `--yes`. При смешанном или повреждённом layout миграция не запускается.

`scripts/migrate-legacy-server.sh` переводит плоскую установку Family Archive в
release-структуру без запуска миграций на рабочей базе во время подготовки.
Скрипт рассчитан на unit `family-tree.service` с точной legacy-командой:

```text
ExecStart=/opt/family-tree/pocketbase serve --http=0.0.0.0:8090
```

Он не предназначен для уже release-based установки и не должен запускаться
параллельно с install, update, backup или rollback.

## Перед запуском

Проверьте доступ к GitHub и npm registry, состояние сервиса и свободное место. Не
удаляйте собственные внешние backups. Для нестандартного root из доверенного checkout
сначала выполните прямой dry-run:

```bash
sudo ./scripts/migrate-legacy-server.sh --dry-run
```

Dry-run проверяет абсолютные нормализованные пути, отсутствие симлинков и `..`,
legacy-каталоги, unit, свободное место и конфликты целевых путей. Он не останавливает
сервис, не создаёт backup и не обращается к GitHub.

Прямая in-place миграция после проверки (без `--yes` она также запросит
подтверждение):

```bash
sudo ./scripts/migrate-legacy-server.sh \
  --legacy-root /opt/family-tree \
  --install-root /opt/family-tree \
  --repo https://github.com/Garbage85/family-archive.git \
  --branch main
```

Поддерживаются также разные, не вложенные друг в друга `legacy-root` и
`install-root`. Существующий отдельный `install-root` не перезаписывается.

## Порядок операции

До первого изменения legacy-каталога мигратор:

1. проверяет layout, unit, команды ОС, пути и место;
2. останавливает сервис и создаёт preflight offline backup `pb_data`, миграций,
   исходного unit и JSON metadata;
3. проверяет tar и его SHA-256;
4. снова запускает и проверяет legacy-сервис;
5. во внешнем временном каталоге получает Git mirror и выполняет `npm ci`, lint,
   `format:check`, check, test и build;
6. проверяет JavaScript-миграции, скачивает закреплённый PocketBase, проверяет ZIP и
   SHA-256 и полностью собирает новый release.

Production `pb_data` на этом этапе не передаётся новому PocketBase. Затем мигратор
получает `flock`, снова останавливает сервис и создаёт второй final offline backup.
Только после его проверки старый root переименовывается, данные публикуются как
`shared/pb_data`, миграции выполняются отдельной командой, устанавливается новый
unit, атомарно создаётся `current`, выполняется `daemon-reload` и запускается сервис.
Успех требует active systemd unit, TCP на сохранённом legacy-порту, HTTP 200 для `/` и успешный
`/api/health`.

Оба проверенных архива и `.sha256` после успеха находятся в
`/opt/family-tree/backups`.

## Сохранённая legacy-установка

Старая установка никогда не удаляется. Для in-place операции она получает имя вида:

```text
/opt/family-tree.legacy-YYYYMMDD-HHMMSS
```

По умолчанию `pb_data` физически перемещается в `shared/pb_data`, а в сохранённом
legacy-каталоге создаётся симлинк на эту единственную рабочую копию. Так две версии
PocketBase не могут независимо менять две базы.

Опция `--keep-legacy` вместо этого оставляет отдельный физический снимок старого
`pb_data`. Только после успешного health check снимок рекурсивно переводится в
read-only режим. Он служит для расследования, а не для запуска старого сервиса;
источником восстановления остаётся final backup.

## Автоматический rollback

Любая ошибка после начала cutover останавливает новую версию, переносит неудачную
новую структуру в соседний каталог `.failed-migration-*`, возвращает legacy-root и
старый unit, восстанавливает `pb_data` из final backup, выполняет `daemon-reload` и
возвращает исходные active/inactive и enabled/disabled состояния сервиса. После
ошибки печатается `ROLLBACK REPORT` с этапом, результатом восстановления, состоянием
сервиса и путём recovery artifacts.

Если отчёт имеет `result: INCOMPLETE`, не запускайте обе версии вручную. Сохраните
указанные каталоги и архивы, проверьте:

```bash
sudo systemctl cat family-tree
sudo systemctl status family-tree --no-pager
sudo sha256sum --check /PATH/TO/family-archive-legacy-*-final.tar.gz.sha256
sudo tar -tzf /PATH/TO/family-archive-legacy-*-final.tar.gz
```

Не извлекайте архив от root до проверки путей и checksum. Мигратор не читает
`deployment.env` через `source`: рабочий файл создаётся из проверенных значений
конфигурации и устанавливается с режимом `0600`.

Мигратор извлекает `LISTEN_HOST` и `PORT` из единственного проверенного legacy
`ExecStart` и переносит их в новый `deployment.env`. Поэтому нестандартный порт не
сбрасывается на 8090. Передать `--port` через единый bootstrap для migration нельзя:
порт следует менять после успешной миграции отдельной командой
`sudo family-archive update --change-port PORT`.
