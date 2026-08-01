# Архитектура Family Archive

## Назначение

Family Archive — self-hosted одностраничное приложение. PocketBase хранит данные,
выполняет авторизацию и раздаёт собранные статические файлы. Frontend работает с API
PocketBase через JavaScript SDK с того же origin.

Документ описывает архитектуру релиза 0.3. В этом релизе схема базы данных и формат
`trees.data` остаются без изменений.

## Компоненты

```text
Browser
  └─ Family Archive SPA
       ├─ UI and application flow       src/main.js, src/ui.js
       ├─ Tree domain operations        src/tree-utils.js
       ├─ PocketBase gateway            src/api.js
       └─ Family Chart adapter          src/adapters/family-chart-adapter.js
              └─ family-chart package

PocketBase
  ├─ Auth and collection API
  ├─ SQLite data in pb_data
  ├─ Uploaded files in pb_data
  └─ Static frontend from pb_public
```

## Frontend boundaries

### Application and UI

`main.js` координирует сессию, локальное рабочее состояние дерева, сохранение и
модерацию. `ui.js` создаёт собственные формы и диалоги. Встроенный редактор Family
Chart не является частью приложения.

### Tree operations

`tree-utils.js` содержит операции, не зависящие от PocketBase и Family Chart:
нормализацию, валидацию, создание и изменение людей и связей, удаление и сравнение
снимков дерева.

### API gateway

`api.js` — единственная точка прямого взаимодействия frontend с PocketBase SDK. API и
правила коллекций в Foundation 0.3 не меняются.

### Family Chart adapter

`family-chart-adapter.js` — единственный модуль, который импортирует пакет
`family-chart` и его CSS. Адаптер:

- преобразует входной снимок в данные renderer;
- создаёт и обновляет chart;
- управляет фокусом, масштабом и ориентацией;
- преобразует нажатие на карточку в callback с человеком;
- подключает поиск человека.

ESLint запрещает прямой импорт `family-chart` из остальных frontend-модулей. Адаптер
не изменяет источник истины и не использует встроенный редактор библиотеки.

## Поток данных

1. После авторизации `api.js` получает запись `trees`.
2. `main.js` создаёт локальную копию `trees.data` в `workingData`.
3. Собственный UI применяет к этой копии функции из `tree-utils.js`.
4. Adapter получает копию данных только для отображения.
5. Администратор сохраняет снимок в `trees`; участник создаёт `proposal`.

Источник истины во время сессии — `workingData`, а после успешного сохранения — запись
PocketBase. Family Chart никогда не является источником истины.

## Сборка и проверки

Зависимости фиксируются `package-lock.json` и устанавливаются через `npm ci`.
GitHub Actions и локальный процесс выполняют одинаковые проверки: ESLint, Prettier,
синтаксис Node.js, unit-тесты и production build Vite.

## Ограничения текущей архитектуры

- всё дерево хранится единым JSON-снимком;
- проверка ревизии выполняется несколькими API-запросами;
- предложение содержит полный снимок, а не набор операций;
- модель пока не содержит отдельных событий, документов и источников.

Эти ограничения планируется устранять последовательно после Foundation 0.3.
