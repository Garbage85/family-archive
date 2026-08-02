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

Недостающие `git`, `curl`, `unzip`, `rsync`, `jq`, Node.js/npm, systemd, tar,
coreutils, util-linux и iproute2 устанавливаются через apt. Скрипт принимает Node.js
18+, но для разработки и CI используется Node.js 22. Если версия из вашего Debian
старее, сначала установите актуальный Node.js из доверенного репозитория ОС.

## Чистая установка

Рекомендуемый bootstrap-вариант описан в [BOOTSTRAP.md](BOOTSTRAP.md):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh)
```

Установка из предварительно клонированного checkout:

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

2. Подключитесь через SSH port forwarding и откройте `http://127.0.0.1:8090/_/`:

   ```bash
   ssh -L 8090:127.0.0.1:8090 USER@SERVER
   ```

3. Создайте superuser в браузере и сохраните пароль в менеджере паролей.

Если superuser уже есть, установка не создаёт и не меняет его.

## systemd и hardening

Unit работает от `familytree`, использует `WorkingDirectory=/opt/family-tree/current`,
запрещает автоматическое создание миграций и разрешает запись только в
`shared/pb_data`. Включены `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`PrivateDevices`, `NoNewPrivileges` и дополнительные ограничения systemd.

## Существующая legacy-установка

`install-server.sh` — только для чистой установки. Он сознательно не переносит
старый `/opt/family-tree/pb_data` автоматически. Для перехода со старой плоской
схемы сначала создайте проверенный offline backup, остановите старый unit, перенесите
`pb_data` в `shared/pb_data`, установите новую структуру в отдельном каталоге и лишь
после проверки переключите unit. Автоматическая in-place конвертация не реализована,
чтобы исключить неявное изменение production-данных.

Скрипты не изменяют Docker, Nextcloud и Nginx Proxy Manager.
