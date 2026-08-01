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

## Установка

Новая установка на поддерживаемом Linux-сервере:

```bash
sudo ./scripts/install.sh
```

Обновление уже установленного экземпляра:

```bash
sudo ./scripts/deploy-update.sh
```

Перед обновлением production-экземпляра рекомендуется создать резервную копию через
`scripts/backup.sh`.

## Документация

- [Архитектура](docs/ARCHITECTURE.md)
- [База данных](docs/DATABASE.md)
- [План развития](docs/ROADMAP.md)
- [ADR-0001: Family Chart только как renderer](docs/ADR/0001-family-chart-renderer-only.md)
- [Настройка Nginx Proxy Manager](docs/NGINX_PROXY_MANAGER.md)

## Лицензии

Список сторонних компонентов приведён в [LICENSES.md](LICENSES.md).
