# Family Archive 0.3 Foundation

Family Archive — self-hosted семейный архив на PocketBase с интерактивным семейным
деревом, фотографиями и совместным редактированием.

Релиз 0.3 стабилизирует структуру проекта без изменения пользовательского поведения,
PocketBase API, схемы базы данных и формата `trees.data`.

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

Чистая установка на Raspberry Pi / Debian одной командой:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Garbage85/family-archive/main/scripts/bootstrap.sh)
```

Bootstrap проверяет окружение, при необходимости устанавливает только `git`, клонирует
репозиторий во временный каталог и передаёт установку штатному `install-server.sh`.
Подробности и вариант установки из локального checkout: [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md).

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
- [Bootstrap и командный launcher](docs/BOOTSTRAP.md)
- [Обновление](docs/UPDATING.md)
- [Backup и rollback](docs/BACKUP_AND_ROLLBACK.md)
- [План развития](docs/ROADMAP.md)
- [ADR-0001: Family Chart только как renderer](docs/ADR/0001-family-chart-renderer-only.md)
- [Настройка Nginx Proxy Manager](docs/NGINX_PROXY_MANAGER.md)

## Лицензии

Список сторонних компонентов приведён в [LICENSES.md](LICENSES.md).
