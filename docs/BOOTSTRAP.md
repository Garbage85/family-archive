# Bootstrap и командный launcher

## Единая команда

Для чистой системы, release-установки и legacy-установки используется одна и та же
рекомендуемая команда от обычного пользователя с правом `sudo`:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh)
```

Перед запуском проверьте URL и при необходимости сначала просмотрите скрипт:

```bash
curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh
```

Bootstrap остаётся небольшим диспетчером:

1. Проверяет Linux, Bash 4+, `sudo`, `curl` и `git`.
2. Проверяет абсолютный install root, владельца, права и отсутствие опасных symlink.
3. Клонирует выбранные `--repo` и `--branch` в новый временный checkout.
4. Классифицирует `/opt/family-tree` без попыток исправить его:
   - отсутствующий или пустой root — `install-server.sh`;
   - проверенные `current`, `releases`, `shared`, release и repository mirror —
     `update-server.sh`;
   - обычные `pocketbase` и `pb_data` без release-маркеров —
     `migrate-legacy-server.sh`;
   - смешанное, неполное или небезопасное состояние — диагностика и отказ.
5. Через `sudo` запускает только штатный скрипт из свежего checkout.
6. Удаляет временный checkout после успеха, ошибки или сигнала.

Bootstrap не содержит реализации install, update или migrate, не запускает скрипты
из `current` и не выполняет второй `curl | bash`. Разрешённые для выбранного режима
аргументы передаются дочернему скрипту отдельным массивом без `eval`; остальные
отклоняются.

Для fork или другой ветки:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) \
  --repo https://github.com/OWNER/family-archive.git --branch main
```

Сам bootstrap в команде выше загружается из официальной ветки `main`; `--repo` и
`--branch` задают свежий checkout и источник дальнейшего install/update/migrate, но
не дублируются как дочерние CLI-аргументы.

## Выбор режима и подтверждение

Перед запуском печатается обнаруженный тип и действие. Автоматический режим можно
подтвердить совместимой forced-опцией:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) --install
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) --update
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) --migrate
```

Forced-режим не обходит классификацию: например, `--migrate` на release-layout
завершится ошибкой. Режимы нельзя комбинировать.

`--dry-run` передаётся выбранному штатному скрипту. Для legacy реальная миграция
всегда предваряется отдельным dry-run. После него bootstrap запрашивает `y`; для
неинтерактивного подтверждения используется `--yes`:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) --dry-run
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) --yes
```

При повреждённом layout bootstrap ничего не запускает, показывает типы ключевых
путей и предлагает `family-archive doctor` либо ручную проверку.

## Мастер и параметры установки

На чистой системе при TTY и без `--yes` запускается мастер. Enter принимает
значения по умолчанию: `Family Archive`, порт 8090, системный часовой пояс и
включённый systemd. Если 8090 занят, предлагается первый свободный порт 8091–8190.
Перед изменениями выводится полный план и запрашивается подтверждение. Ctrl+C или
отрицательный ответ завершают работу без изменений.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) \
  --yes \
  --port 8095 \
  --site-name "Архив семьи Сапожниковых" \
  --timezone Asia/Chita
```

`--no-systemd` оставляет собранную установку без созданного и запущенного unit.
`--dry-run` проверяет layout, timezone и доступность предполагаемого порта, печатает
план и ничего не изменяет. Явный занятый `--port` всегда является ошибкой с
доступными сведениями о слушателе. Автопоиск никогда не выходит за 8091–8190.

Для release-установки `--port` намеренно отклоняется. Осознанная смена выполняется
так:

```bash
sudo family-archive update --change-port 8096
```

Она создаёт backup, меняет config и unit, перезапускает сервис и выполняет health
check; при ошибке старые порт и unit восстанавливаются. Legacy migration всегда
берёт адрес и порт из проверенного старого `ExecStart`.

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
откажется перезаписывать `/opt/family-tree`. Единый bootstrap сам выберет update.

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

- Bootstrap рассчитан на Linux и требует заранее установленные `sudo`, `curl`, `git`
  и базовые GNU coreutils.
- Для загрузки bootstrap, репозитория, npm-пакетов и PocketBase требуется сеть.
- Автодетект рассчитан на стандартный root `/opt/family-tree`; нестандартный root
  обслуживается прямыми штатными скриптами и конфигурацией.
- Небезопасный владелец, group/world-write, symlink в install root, drop-in или
  неполный layout требуют ручного разбора.
- Команда из raw.githubusercontent.com использует опубликованную ветку `main` и не
  видит локальные или ещё не опубликованные изменения.
