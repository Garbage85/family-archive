# Установка Family Archive на Raspberry Pi / Debian

Новая схема установки использует неизменяемые releases и общий каталог данных:

```text
/opt/family-tree/
├── app/repository.git       # локальное read-only зеркало GitHub для подготовки releases
├── backups/                 # проверенные tar.gz и SHA-256
├── current -> releases/...  # атомарно переключаемая ссылка
├── releases/<id>/           # pocketbase, pb_public, pb_migrations, scripts, metadata
└── shared/
    ├── pb_data/             # единственный изменяемый каталог приложения
    └── deployment.env       # копия несекретной конфигурации установки
```

Рабочая конфигурация хранится также в `/etc/family-tree/deployment.env` с правами
`0600`. Пароли, токены и ключи туда добавлять нельзя.

## Требования

- Raspberry Pi OS или Debian с systemd и apt;
- `arm64`/`aarch64`, `armv7l` или `amd64`/`x86_64`;
- root-доступ через `sudo`;
- доступ к GitHub и npm registry;
- минимум 512 MiB свободного места по умолчанию.

Для единого bootstrap команды `curl`, `git` и `sudo` должны быть установлены заранее.
Недостающие зависимости штатной установки — `unzip`, `rsync`, `jq`, Node.js/npm,
systemd, tar, coreutils, util-linux и iproute2 — устанавливаются через apt. Скрипт
принимает Node.js 18+, но для разработки и CI используется Node.js 22. Если версия из
вашего Debian старее, сначала установите актуальный Node.js из доверенного репозитория
ОС.

## Единый bootstrap

Первая рекомендуемая команда одинакова для чистой установки, обновления и
legacy-миграции:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh)
```

Bootstrap безопасно классифицирует стандартный `/opt/family-tree` и запускает
`install-server.sh`, `update-server.sh` либо подтверждаемую legacy-миграцию только из
свежего временного checkout. Повреждённый или смешанный layout не изменяется.

На чистой системе интерактивный мастер спрашивает только имя сайта, HTTP-порт,
часовой пояс приложения и необходимость systemd. Пароли, токены и email
администратора не запрашиваются; домен, TLS и Nginx Proxy Manager не настраиваются.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) \
  --yes --port 8095 \
  --site-name "Архив семьи Сапожниковых" \
  --timezone Asia/Chita
```

Порт должен быть целым числом 1024–65535. Если стандартный 8090 занят, мастер
предлагает первый свободный 8091–8190, а `--yes` выбирает его автоматически. Явно
заданный занятый порт не заменяется. Для установки без unit добавьте `--no-systemd`.

## Прямая чистая установка

Установка из предварительно клонированного доверенного checkout:

```bash
git clone https://github.com/Garbage85/family-archive.git
cd family-archive
sudo ./scripts/install-server.sh
```

Другая ветка или fork:

```bash
sudo ./scripts/install-server.sh --branch main \
  --repo https://github.com/Garbage85/family-archive.git
```

До запуска можно скопировать и изменить конфигурацию, а затем установить её как
root-owned файл:

```bash
cp config/deployment.env.example config/deployment.env
${EDITOR:-vi} config/deployment.env
sudo install -d -o root -g root -m 0755 /etc/family-tree
sudo install -o root -g root -m 0600 config/deployment.env /etc/family-tree/deployment.env
sudo ./scripts/install-server.sh --config /etc/family-tree/deployment.env
```

`config/deployment.env` игнорируется Git и остаётся только локальной заготовкой.
Runtime-конфиг допускает только известные строки `KEY=VALUE`: shell-выражения,
неизвестные ключи, многострочные значения, симлинки, group-write и world-write
отклоняются. При запуске от root владельцем файла также обязан быть root. Файл
`config/deployment.env.example` служит только примером и скриптами не исполняется.

Сетевые настройки хранятся раздельно: `LISTEN_HOST` и `PORT`. Допустимы loopback и
wildcard адреса (`127.0.0.1`, `0.0.0.0`, `::1`, `::`) либо IP, назначенный локальному
интерфейсу. `TIMEZONE` проверяется по `timedatectl list-timezones` или базе zoneinfo
и применяется только к приложению через unit; системный часовой пояс скрипт не
меняет.

Checksum должен соответствовать точному архиву закреплённой версии PocketBase.
Скрипт откажется перезаписывать непустой
`/opt/family-tree`, существующий unit или неизвестную архитектуру. Из-за
`ProtectHome=true` альтернативный `INSTALL_ROOT` нельзя размещать в `/home` или
`/root`; путь не должен содержать пробелы или `..`.

Установка выполняет `npm ci`, lint, format check, syntax check, тесты и build до
создания active release. Затем она проверяет миграции, SHA-256 PocketBase, применяет
миграции, включает unit и проверяет systemd, TCP-порт, `/` и `/api/health`.

Если ошибка происходит после создания layout, installer удаляет созданные unit и
`current`, а незавершённое состояние вместе с `pb_data` перемещает в соседний каталог
`/opt/family-tree.failed-install-YYYYMMDD-HHMMSS`. Данные не удаляются; перед
повторным запуском проверьте сообщение с точным путём сохранённого каталога.

## Первый superuser

Пароль намеренно не принимается аргументом или переменной окружения: аргументы видны
в process list, а окружение нередко попадает в диагностические дампы. Для явной
инструкции запустите чистую установку с `--admin-instructions`. После установки:

1. Найдите одноразовую installer-ссылку в журнале:

   ```bash
   sudo journalctl -u family-tree --no-pager | grep -i installer
   ```

2. Подключитесь через SSH port forwarding, подставив фактический `PORT`, и откройте
   `http://127.0.0.1:PORT/_/`:

   ```bash
   ssh -L PORT:127.0.0.1:PORT USER@SERVER
   ```

3. Создайте superuser в браузере и сохраните пароль в менеджере паролей.

Если superuser уже есть, установка не создаёт и не меняет его.

## systemd и hardening

Unit работает от `familytree`, использует `WorkingDirectory=/opt/family-tree/current`,
запрещает автоматическое создание миграций и разрешает запись только в
`shared/pb_data`. Включены `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`PrivateDevices`, `NoNewPrivileges` и дополнительные ограничения systemd.

## Существующая legacy-установка

Для стандартного root используйте ту же единую команду:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh)
```

Bootstrap сам выполняет обязательный legacy dry-run и запрашивает подтверждение;
`--yes` разрешает неинтерактивное продолжение. Прямой мигратор остаётся доступен для
нестандартных root. Полная процедура, `--keep-legacy` и rollback описаны в
[LEGACY_MIGRATION.md](LEGACY_MIGRATION.md).

Скрипты не изменяют Docker, Nextcloud и Nginx Proxy Manager.
