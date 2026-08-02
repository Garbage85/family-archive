# Family Archive 0.3 Foundation

Family Archive — self-hosted семейный архив на PocketBase с интерактивным семейным
деревом, фотографиями и совместным редактированием.

Релиз 0.3 стабилизирует структуру проекта без изменения пользовательского поведения,
PocketBase API, схемы базы данных и формата `trees.data`.

Единая рекомендуемая команда сервера для install, update и legacy migration:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh)
```

Неинтерактивная установка с явными настройками:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) \
  --yes \
  --port 8095 \
  --site-name "Архив семьи Сапожниковых" \
  --timezone Asia/Chita
```

Проверка плана ничего не меняет:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh) --dry-run
```

При чистой интерактивной установке мастер предлагает имя сайта, первый свободный
порт начиная с 8090, текущий системный часовой пояс и systemd. Эти значения
сохраняются декларативно как `SITE_NAME`, `LISTEN_HOST`, `PORT`, `TIMEZONE` и
`ENABLE_SYSTEMD`; конфиг не исполняется shell. Домен, TLS и reverse proxy мастер не
настраивает.

## Возможности текущей версии

- собственная карточка человека;
- имя, фамилия, отчество, пол, даты, место рождения, профессия и заметки;
- фотография профиля;
- добавление родителя, супруга, ребёнка, брата или сестры;
- удаление человека;
- поиск, масштабирование и смена ориентации дерева;
- роли `viewer`, `member` и `admin`;
- предложения изменений и модерация;
- экспорт дерева в JSON.

Family Chart используется только через
`frontend/src/adapters/family-chart-adapter.js` как движок отображения дерева. Его
встроенный редактор не используется: просмотр и редактирование выполняются собственным
интерфейсом Family Archive.

## Локальная разработка

Требуется Node.js 22.

```bash
cd frontend
npm ci
npm run dev
```

Полный набор проверок:

```bash
npm run lint
npm run format:check
npm run check
npm test
npm run build
```

Собранный frontend записывается в `pb_public`, откуда его обслуживает PocketBase.

## Установка и обслуживание сервера

Эта же команда безопасно выбирает чистую установку, обновление release-установки или
миграцию legacy-схемы:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh)
```

Bootstrap проверяет layout `/opt/family-tree`, клонирует свежий репозиторий во
временный каталог и запускает из него ровно один штатный workflow: install, update
либо безопасный legacy dry-run с подтверждаемой миграцией. Неоднозначный layout
останавливается с диагностикой. Подробности: [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md).

После успешной установки доступен единый launcher:

```bash
family-archive update
family-archive backup
family-archive rollback --previous
family-archive status
family-archive doctor
family-archive logs
family-archive version
```

Для существующих сценариев сохранены совместимые команды:

```bash
family-archive-update --dry-run
family-archive-backup
family-archive-rollback --previous
family-archive-status
```

Launcher сам вызывает `sudo` для привилегированных операций. Безопасное обновление
по-прежнему создаёт backup и выполняет автоматический rollback при ошибке.

Production использует неизменяемые releases, атомарный симлинк `current` и общий
`shared/pb_data`. Скрипты не выполняют `git pull` в активной версии и не изменяют
данные без install, миграции либо явного restore.

## Документация

- [Архитектура](docs/ARCHITECTURE.md)
- [База данных](docs/DATABASE.md)
- [Установка сервера](docs/INSTALLATION.md)
- [Миграция legacy-установки](docs/LEGACY_MIGRATION.md)
- [Bootstrap и командный launcher](docs/BOOTSTRAP.md)
- [Обновление](docs/UPDATING.md)
- [Backup и rollback](docs/BACKUP_AND_ROLLBACK.md)
- [План развития](docs/ROADMAP.md)
- [ADR-0001: Family Chart только как renderer](docs/ADR/0001-family-chart-renderer-only.md)
- [Настройка Nginx Proxy Manager](docs/NGINX_PROXY_MANAGER.md)

## Лицензии

Список сторонних компонентов приведён в [LICENSES.md](LICENSES.md).
