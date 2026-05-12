# Миграция: @diplodoc/lint → @diplodoc/infra

## Обзор

Пакет `@diplodoc/lint` переименовывается в `@diplodoc/infra`. Помимо смены имени,
меняется модель распространения инфраструктуры: вместо pull-модели (потребитель тянет
обновления при `npm run lint`) используется push-модель (infra сама создаёт PR в каждой репе).

## Диаграмма процесса миграции

```mermaid
flowchart TD
    A[1. Запушить изменения кода<br/>в lint репу] --> B[2. Переименовать репо на GitHub<br/>lint → infra]
    B --> C[3. Обновить локальный remote URL]
    C --> D[4. Переместить сабмодуль в метапакете<br/>git mv devops/lint devops/infra]
    D --> E[5. Первая публикация @diplodoc/infra<br/>npm publish --access public]
    E --> F[6. Deprecated @diplodoc/lint<br/>npm deprecate]
    F --> G[7. Создать release tag → <br/>distribute-infra.yml срабатывает]
    G --> H{PR во все репы-потребители}
    H --> I[package.json: lint → infra]
    H --> J[scaffolding файлы обновлены]
    H --> K[version обновлена]
    I & J & K --> L[8. Замержить PR<br/>auto-merge или вручную]
    L --> M[Миграция завершена]
```

## Пошаговая инструкция

### Шаг 1. Запушить все изменения кода в lint репу

Все изменения (новый `bin/infra.js`, обновлённый `package.json`, workflows,
`distribution.yml`, scaffolding и т.д.) нужно сначала запушить в текущую
репу `diplodoc-platform/lint`, пока она ещё не переименована.

```bash
cd devops/lint

git add -A
git commit -m "feat!: rename to @diplodoc/infra, switch to push distribution model

BREAKING CHANGE: package renamed from @diplodoc/lint to @diplodoc/infra.
npm run lint no longer pulls infrastructure updates.
Infrastructure is now distributed via automated PRs."

git push origin master
```

> **Важно:** Пушим именно в `lint` репу — она пока что так называется.
> Все workflows и конфиги уже подготовлены к новому имени.

### Шаг 2. Переименовать репозиторий на GitHub

```
GitHub → diplodoc-platform/lint → Settings → General → Repository name → "infra" → Rename
```

GitHub автоматически создаст редирект со старого URL. Существующие клоны и
ссылки (`git@github.com:diplodoc-platform/lint.git`) продолжат работать через редирект.

### Шаг 3. Обновить remote URL локально

```bash
cd devops/lint

git remote set-url origin git@github.com:diplodoc-platform/infra.git
git remote -v  # Проверить
```

### Шаг 4. Переместить сабмодуль в метапакете

```bash
cd /Users/gold-serg/Projects/diplodoc

# Переместить сабмодуль (обновит .gitmodules и .git/config)
git mv devops/lint devops/infra

# Убедиться что URL обновился
git config -f .gitmodules submodule.devops/infra.url git@github.com:diplodoc-platform/infra.git

# Синхронизировать конфигурацию
git submodule sync

# Закоммитить и запушить
git add .gitmodules devops/infra
git commit -m "chore: rename submodule devops/lint → devops/infra"
git push
```

### Шаг 5. Первая публикация @diplodoc/infra в npm

```bash
cd devops/infra

# Убедиться что в package.json:
#   "name": "@diplodoc/infra"
#   "version": "1.0.0"

# Первая публикация нового scoped-пакета
npm publish --access public
```

> **Примечание:** `--access public` обязателен для первой публикации scoped-пакета.
> При последующих публикациях (через release-please) он не нужен — npm запоминает настройку.

### Шаг 6. Пометить старый пакет как deprecated

```bash
npm deprecate @diplodoc/lint "Renamed to @diplodoc/infra. Update: npm i -D @diplodoc/infra"
```

### Шаг 7. Создать release и запустить распространение

Вариант А — создать release через GitHub (триггерит `distribute-infra.yml` автоматически):

```bash
gh release create v1.0.0 \
  --repo diplodoc-platform/infra \
  --title "v1.0.0" \
  --notes "Initial release as @diplodoc/infra (renamed from @diplodoc/lint).

## Breaking Changes
- Package renamed: \`@diplodoc/lint\` → \`@diplodoc/infra\`
- \`npm run lint\` no longer pulls infrastructure updates
- Infrastructure updates now distributed via automated PRs"
```

Вариант Б — ручной запуск workflow (если релиз уже создан или не нужен):

```bash
gh workflow run distribute-infra.yml \
  --repo diplodoc-platform/infra \
  --field target=all \
  --field version=v1.0.0
```

Workflow автоматически для каждой репы-потребителя:

- Склонирует репу
- Скопирует scaffolding файлы (уже ссылаются на `@diplodoc/infra`)
- Заменит `@diplodoc/lint` → `@diplodoc/infra` в `devDependencies`
- Обновит версию до `1.0.0`
- Создаст PR `chore: update infrastructure to v1.0.0`

### Шаг 8. Замержить PR в потребителях

Если `auto_merge: true` в `distribution.yml` — PR замержится сам после прохождения CI.
Если `auto_merge: false` (текущий default) — вручную просмотреть и замержить каждый PR.

> Все PR будут одинакового формата и создадутся параллельно (max 5 одновременно).

### Шаг 9. Обновить локальные окружения других разработчиков

Другим разработчикам метапакета достаточно:

```bash
git pull
git submodule sync
git submodule update --init
```

---

## Что произойдёт в каждой репе-потребителе при мерже PR

| Файл                  | Изменение                                                          |
| --------------------- | ------------------------------------------------------------------ |
| `package.json`        | `@diplodoc/lint` удалён → `@diplodoc/infra: "1.0.0"` добавлен      |
| `.eslintrc.js`        | `require('@diplodoc/lint/...')` → `require('@diplodoc/infra/...')` |
| `.prettierrc.js`      | Аналогично                                                         |
| `.stylelintrc.js`     | Аналогично                                                         |
| `.lintstagedrc.js`    | Аналогично                                                         |
| `.github/workflows/*` | Обновлены из scaffolding (если не в blacklist)                     |
| `package-lock.json`   | Пересоздан с новым пакетом                                         |

---

## Что меняется в командах

| Было                  | Стало                                    | Разница                                                |
| --------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `npm run lint`        | `npm run lint`                           | Теперь **только линтинг**, без подтягивания обновлений |
| `lint update && lint` | `lint`                                   | `update` убран из скриптов потребителей                |
| `lint init`           | `infra init`                             | Новая команда для инициализации                        |
| —                     | `infra sync --target ./path --repo name` | Применить scaffolding к целевой папке                  |
| —                     | `infra blacklist show`                   | Показать blacklist для репы                            |

---

## Обратная совместимость

- Бинарный файл `lint` **сохранён** — `npm run lint` продолжает работать
- Конфиги (`.eslintrc.js` и т.д.) некоторое время будут проверять оба имени пакета
- GitHub редирект с `diplodoc-platform/lint` → `diplodoc-platform/infra` работает автоматически
- Если в потребителе осталась старая зависимость `@diplodoc/lint` — следующий distribute-PR заменит её

---

## FAQ

### Новая репа добавлена в мультирепу — что произойдёт?

1. При пуше в master `.gitmodules` с новым сабмодулем → `sync-packages-list.yml` сработает
2. Новая репа будет добавлена в `distribution.yml`
3. **Автоматически** запустится `distribute-infra.yml` для этой репы
4. PR с инфраструктурой будет создан в новой репе

Если workflow не сработал (например, `.gitmodules` обновили без пуша в master):

```bash
gh workflow run distribute-infra.yml \
  --repo diplodoc-platform/infra \
  --field target=<имя-новой-репы>
```

### Нужно ли обновлять package-template?

Да. После миграции обнови `package-template` чтобы новые репы сразу ссылались на `@diplodoc/infra`.

### Что если CI упадёт в потребителе после PR?

1. Проверь какой файл вызвал проблему
2. Добавь его в blacklist (`.infrarc.yml` в репе ИЛИ `distribution.yml` централизованно)
3. Пересоздай PR: ручной запуск `distribute-infra.yml` с `target=<repo>`
