# Bootstrap и командный launcher

## Установка одной командой

На чистом Raspberry Pi OS или Debian выполните от обычного пользователя с правом
`sudo`:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh)
```

Перед запуском проверьте URL и при необходимости сначала просмотрите скрипт:

```bash
curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh
```

Bootstrap выполняет только подготовительные действия:

1. Проверяет Linux, Bash 4+, `sudo`, `curl` и `git`.
2. Если `git` отсутствует, устанавливает только его через `apt-get` и `sudo`.
3. Клонирует ветку `main` официального репозитория во временный каталог.
4. Через `sudo` запускает штатный `scripts/install-server.sh`, передавая ему аргументы.
5. Удаляет временный checkout при успехе, ошибке или сигнале.

Создание release, установка зависимостей приложения, миграции, systemd unit и health
checks остаются ответственностью `install-server.sh`. Bootstrap не содержит второй
реализации установки и не обновляет существующую installation in-place.

Аргументы после команды передаются installer. Например, чтобы показать инструкцию
создания первого superuser:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) \
  --admin-instructions
```

Для fork можно передать его штатному installer:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) \
  --repo https://github.com/OWNER/family-archive.git --branch main
```

Сам bootstrap всегда загружается из официальной ветки `main`; `--repo` и `--branch`
задают источник устанавливаемого release.

## Launcher

После успешной установки создаётся симлинк:

```text
/usr/local/bin/family-archive -> /opt/family-tree/current/scripts/family-archive.sh
```

Благодаря ссылке на `current` launcher переключается вместе с release при update или
rollback. Он запрашивает `sudo` сам, поэтому добавлять `sudo` перед обычными командами
не требуется:

```bash
family-archive install
family-archive update
family-archive backup
family-archive rollback --previous
family-archive status
family-archive doctor
family-archive logs
family-archive version
```

`install` остаётся чистой установкой: на уже установленном сервере штатный installer
откажется перезаписывать `/opt/family-tree`. Для обновления используйте `update`.

Аргументы передаются соответствующему серверному скрипту, например:

```bash
family-archive update --dry-run
family-archive backup --keep 14
family-archive rollback --list
family-archive status --json --no-logs
family-archive doctor
family-archive logs --lines 200
family-archive logs --follow
family-archive version --json
```

`doctor` является отдельной read-only диагностикой. Он проверяет команды ОС,
целостность current release, доступ к `pb_data`, systemd, порт, HTTP/API health,
свободное место, последний backup и CLI-ссылки. `version` отдельно читает metadata
текущего release, включая версию приложения из `frontend/package.json`, без сетевого
запроса и без проверки доступности сервиса.

## Совместимые команды

Installer также создаёт относительные симлинки на основной launcher:

```bash
family-archive-update
family-archive-backup
family-archive-rollback
family-archive-status
```

Они принимают те же опции, что соответствующие подкоманды. Старые прямые вызовы
`/opt/family-tree/current/scripts/*-server.sh` продолжают работать.

При переходе с release, в котором launcher ещё отсутствовал, первый update выполняет
старую версию updater и потому не может создать новые CLI-ссылки. После переключения
один раз повторите прямую команду; no-op update установит launcher без нового release:

```bash
sudo /opt/family-tree/current/scripts/update-server.sh
```

## Ограничения

- Bootstrap рассчитан на Linux с `sudo` и `apt-get`; автоматическая установка `git`
  на системах без apt не выполняется.
- Для загрузки bootstrap, репозитория, npm-пакетов и PocketBase требуется сеть.
- Установщик поддерживает только чистую release-based установку. Legacy-layout
  переносится вручную по [docs/INSTALLATION.md](INSTALLATION.md).
- Команда из raw.githubusercontent.com использует опубликованную ветку `main` и не
  видит локальные или ещё не опубликованные изменения.
