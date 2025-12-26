[![NPM version](https://img.shields.io/npm/v/@diplodoc/lint.svg?style=flat)](https://www.npmjs.org/package/@diplodoc/lint)

# @diplodoc/lint

Централизованный набор инструментов для линтинга и форматирования кода в проектах Diplodoc. Объединяет конфигурации ESLint, Prettier, Stylelint и автоматизирует их настройку.

## Возможности

- 🔧 **Автоматическая настройка** — одна команда для инициализации всех инструментов
- 🔄 **Автоматическое обновление** — синхронизация конфигураций между пакетами
- 📦 **Поддержка метапакета и standalone** — работает как часть метапакета и как отдельный npm-пакет
- 🎯 **Единые стандарты** — общие правила линтинга для всех пакетов Diplodoc
- 🚀 **Git hooks** — автоматическая настройка pre-commit хуков через Husky
- 📝 **TypeScript/JavaScript** — полная поддержка обоих языков
- 🎨 **CSS/SCSS** — поддержка стилей через Stylelint

## Установка

```bash
npm install --save-dev @diplodoc/lint
```

## Быстрый старт

### 1. Инициализация

Запустите команду инициализации в корне вашего пакета:

```bash
npx @diplodoc/lint init
```

Эта команда:

- Добавит необходимые скрипты в `package.json`
- Создаст конфигурационные файлы (`.eslintrc.js`, `.prettierrc.js`, `.stylelintrc.js`)
- Настроит Git hooks через Husky
- Обновит `.gitignore`, `.eslintignore`, `.prettierignore`, `.stylelintignore`

После инициализации закоммитьте изменения:

```bash
git add --all && git commit -m 'chore: init lint'
```

### 2. Использование

**Проверка кода:**

```bash
npm run lint
```

**Автоматическое исправление:**

```bash
npm run lint:fix
```

**Обновление конфигураций:**

```bash
npx @diplodoc/lint update
```

> **Примечание**: Команда `update` автоматически выполняется перед каждой проверкой (`npm run lint`), поэтому конфигурации всегда актуальны.

## Команды

### `lint init`

Инициализирует линтинг в пакете:

- Добавляет скрипты в `package.json`:
  - `lint` — проверка кода
  - `lint:fix` — автоматическое исправление
  - `pre-commit` — проверка перед коммитом
  - `prepare` — настройка Husky
- Копирует конфигурационные файлы из `scaffolding/`
- Настраивает Husky для Git hooks
- Обновляет ignore-файлы

### `lint update`

Обновляет конфигурационные файлы до актуальных версий:

- Обновляет `.eslintrc.js`, `.prettierrc.js`, `.stylelintrc.js`
- Обновляет ignore-файлы с новыми паттернами
- **Не** переинициализирует Husky
- **Не** изменяет существующие скрипты в `package.json`

> **Важно**: Эта команда автоматически выполняется перед `lint` и `lint fix`, поэтому конфигурации всегда синхронизированы.

### `lint`

Проверяет код на соответствие правилам:

1. Автоматически выполняет `lint update`
2. Запускает ESLint для JavaScript/TypeScript файлов
3. Запускает Prettier для проверки форматирования
4. Запускает Stylelint для CSS/SCSS файлов (если они есть)

### `lint fix`

Автоматически исправляет найденные проблемы:

1. Автоматически выполняет `lint update`
2. Запускает ESLint с флагом `--fix`
3. Запускает Prettier с флагом `--write`
4. Запускает Stylelint с флагом `--fix` (если есть CSS/SCSS файлы)

## Конфигурация

После инициализации в корне пакета создаются следующие файлы:

### `.eslintrc.js`

```javascript
module.exports = {
  root: true,
  extends: require.resolve('@diplodoc/lint/eslint-config'),
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: true,
  },
};
```

Пакеты могут расширять конфигурацию на уровне `src/`, но не должны переопределять базовые настройки.

### `.prettierrc.js`

```javascript
module.exports = require('@diplodoc/lint/prettier-config');
```

### `.stylelintrc.js`

```javascript
module.exports = {
  extends: require.resolve('@diplodoc/lint/stylelint-config'),
};
```

Создается только если в проекте есть CSS/SCSS файлы.

## Поддерживаемые инструменты

### ESLint

- Конфигурации для TypeScript и JavaScript
- Поддержка React (через `eslint-config/client`)
- Поддержка Node.js (через `eslint-config/node`)
- Project-aware TypeScript парсинг

### Prettier

- Единый стиль форматирования для всех пакетов
- Автоматическое форматирование при сохранении (через редактор)

### Stylelint

- Поддержка CSS и SCSS
- Использует `@gravity-ui/stylelint-config` как базу

### Husky

- Управление Git hooks
- Pre-commit hook запускает `lint-staged`

### lint-staged

- Проверка только измененных файлов
- Быстрая проверка перед коммитом

## Использование в метапакете vs Standalone

Пакет работает в двух режимах:

### В метапакете (workspace mode)

Когда пакет установлен как часть метапакета через npm workspaces:

- Зависимости разрешаются через общий `node_modules`
- Команды работают через workspace-линки
- `package-lock.json` управляется на уровне метапакета

### Standalone режим

Когда пакет используется как отдельный npm-пакет:

- Все зависимости устанавливаются локально
- Команды работают через `node_modules/.bin`
- Для управления `package-lock.json` используйте `npm i --no-workspaces --package-lock-only`

Оба режима поддерживаются автоматически — пакет определяет контекст и работает соответствующим образом.

## Скрипты в package.json

После `lint init` в `package.json` добавляются следующие скрипты:

```json
{
  "scripts": {
    "lint": "lint update && lint",
    "lint:fix": "lint update && lint fix",
    "pre-commit": "lint update && lint-staged",
    "prepare": "husky"
  }
}
```

- `lint` — проверка кода (с автообновлением)
- `lint:fix` — автоматическое исправление (с автообновлением)
- `pre-commit` — проверка перед коммитом (запускается через Husky)
- `prepare` — настройка Husky при установке зависимостей

## Игнорирование файлов

Пакет автоматически обновляет следующие ignore-файлы:

- `.gitignore` — системные файлы, зависимости, артефакты
- `.eslintignore` — системные файлы, зависимости, артефакты, `test/`, `scripts/`
- `.prettierignore` — системные файлы, зависимости, артефакты
- `.stylelintignore` — системные файлы, зависимости, артефакты

Паттерны добавляются автоматически при `init` и `update`, дубликаты не создаются.

## Тестирование

Пакет включает комплексный набор тестов (34 теста):

```bash
# Запуск всех тестов
npm test

# Только unit-тесты
npm run test:unit

# Только integration-тесты
npm run test:integration
```

Тесты используют встроенный модуль Node.js `assert` и не требуют внешних зависимостей.

## Разработка

### Структура пакета

```
@diplodoc/lint/
├── bin/              # Исполняемые скрипты
│   ├── lint         # Основной скрипт
│   ├── eslint       # Прокси для ESLint
│   ├── prettier     # Прокси для Prettier
│   └── ...
├── scripts/         # Вспомогательные скрипты
│   ├── modify-package.js
│   └── modify-ignore.js
├── scaffolding/     # Шаблоны конфигураций
│   ├── .eslintrc.js
│   ├── .prettierrc.js
│   └── ...
└── test/            # Тесты
    ├── unit/
    ├── integration/
    └── helpers/
```

### Внесение изменений

1. Внесите изменения в код
2. Запустите тесты: `npm test`
3. Проверьте линтинг: `npm run lint`
4. Протестируйте в тестовом пакете: `npx @diplodoc/lint init`

## Важные замечания

- **Автообновление**: Команда `lint update` выполняется автоматически при каждом запуске `lint`, что обеспечивает синхронизацию конфигураций
- **Обратная совместимость**: При обновлении конфигураций учитывается обратная совместимость. Breaking changes требуют major версии
- **Независимость**: Пакет не зависит от других пакетов Diplodoc (кроме devops-инфраструктуры)
- **Замена устаревших пакетов**: Этот пакет заменяет `@diplodoc/eslint-config` и `@diplodoc/prettier-config`. Не используйте устаревшие пакеты
- **Критический пакет**: Это критическая инфраструктурная зависимость, используемая всеми пакетами Diplodoc. Изменения должны тщательно тестироваться

## Лицензия

MIT
