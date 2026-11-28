# Разработка и выпуск DeepSeek Harness

[Обзор и установка в GrigDesk](../README.md)

Эта инструкция описывает сборку, проверку, получение допуска GLM и публикацию
выпуска в репозитории `grigdesk-dsh`.

## Что здесь есть

| Каталог | Назначение |
|---|---|
| `src/launcher/` | SEA-лаунчер: распаковка payload в кэш, запуск worker Node |
| `src/host/` | Мосты Harness → GrigDesk: web-хост, ACP settings bridge, gates permissions, GLM gate |
| `src/runtime/` | Metadata, verify, packageId, compatibility |
| `scripts/` | Сборка, установка, admission, smoke, CLI |
| `lib/` | Общие примитивы (hash, файлы, payload-кэш, контракт ELF) и стек GLM/web-клиента |
| `build/` | Описи pinned Node по платформам, licenses, dynamic imports, исходники нативных инструментов macOS (`build/macos/`) |
| `ports/` | Патчи порта под закреплённую версию Harness |
| `vendor/deepseek-harness/` | `upstream.lock.json`, патчи снимка, LICENSE; снимок materialize-ится локально |
| `compatibility/glm.json` | **Список допусков GLM** — вход сборки, tracked в git |
| `contracts/grigdesk-host-contract.json` | Снимок host-контракта GrigDesk — единственный источник ревизий профиля/политики |
| `tests/` | Тесты пакета и хелперы; `tests/run-node-tests-safe.sh` — сторож памяти |
| `.github/workflows/dsh.yml` | Проверки, сборка Linux, macOS, Windows и Android, GitHub Release |

## Быстрый старт

Нужны Node `^22.19.0 || >=24.0.0`, npm, git, tar/xz и C compiler с библиотеками native-зависимостей.

```bash
bin/grigdesk-dsh-ctl build
```

Команда установит зависимости сборки, подготовит закреплённый worker Node и снимок
upstream, соберёт бинарник и проверит его. По умолчанию файл появится в
`~/.cache/grigdesk-dsh/out/deepseek`. `GRIGDESK_DSH_CACHE` меняет корень кэша,
`--out-dir` меняет папку результата.

Для ручной подготовки снимка с локальным источником передайте в
`npm run prepare:upstream --` флаг `--seed-dir <каталог>` для проверенной копии
или `--source-dir <git>` для локального Git с нужным коммитом.
В Windows ZIP Node и Git-архив upstream распаковывает BSD tar из `System32`.

## Поток релиза

При пуше в `main` и в pull request CI проверяет типы и границы импортов. Полный набор тестов
и сборки запускаются при пуше тега `v*`.

| Цели | Проверка в CI | Результат |
|---|---|---|
| Linux x64 и ARM64, macOS ARM64 | `--verify --json` и metadata на нативных runner | Бинарники и `.sha256` в GitHub Release |
| Windows x64 и ARM64 | `--verify --json` и metadata на нативных runner | `dsh-win32-x64.exe`, `dsh-win32-arm64.exe` и `.sha256` в GitHub Release |
| Android `arm64-v8a` и `x86_64` | ELF, загрузчик Bionic, выравнивание сегментов, ресурс SEA и контрольные суммы | Артефакты Actions `dsh-android-arm64-v8a` и `dsh-android-x86_64` |

Допуск GLM — это вход сборки. Живой smoke требует ключи Z.ai, поэтому выполняется
**локально**, а CI собирает все платформы из уже зафиксированного `compatibility/glm.json`.

```
1. git tag v1.2.0-rc.1 && git push --tags
   → Actions: проверки, настольные бинарники и комплекты Android, предварительный GitHub Release

2. локально:
   gh release download v1.2.0-rc.1 -p 'dsh-linux-x64*' -D /tmp/dsh-rc
   bin/grigdesk-dsh-ctl admit --binary /tmp/dsh-rc/dsh-linux-x64 --mode api --admit
   → identity по --runtime-info ELF → живой smoke (3 хода, HTTP-ошибки Z.ai)
   → запись {mode, compatibility} в compatibility/glm.json

   Допуск берётся на ELF **из rc-релиза**, а не на локальной сборке: identity включает
   hashes сборочных скриптов (`scripts/*.ts`), поэтому локально собранный другим коммитом
   ELF даст другой identity, чем CI. Правка любого файла из списка `deepSeekBuildInputs`
   требует нового admit.

3. коммит с glm.json → git tag v1.2.0 && git push --tags
   → Actions собирает все цели с допуском. Stable-гейт проверяет фактический Linux x64 ELF
     и metadata каждого настольного бинарника. GitHub Release содержит пять бинарников,
     manifest.json и контрольные суммы.

4. GrigDesk: установка или обновление из карточки DeepSeek или GLM

5. локально, после стабильного релиза:
   bin/grigdesk-dsh-ctl publish-npm --tag v1.2.0
   → manifest релиза доступен → tarball @grigdesk/dsh@1.2.0 → npm publish из ~/.npmrc
```

Identity допуска не зависит от платформы, пути и buildId — только входы Harness
(upstream commit, патчи, composition, dependency lock, исходник плагина), ревизии
профиля/политики из host-контракта и baseURL режима. Поэтому один smoke на Linux
даёт допуск всем целям одной generation.

### Комплекты Android

Сборка выполняется на Linux x64 с CMake. Workflow берёт версию Node и NDK r28c из `ndk.lock.json`
закреплённой ревизии сборщика GrigDesk. `scripts/prepareAndroidNode.sh` сверяет архивы по SHA-256
и применяет патч поиска SEA в Bionic. `scripts/buildAndroid.mts` собирает поколение Harness,
нативные модули для нужного ABI и комплект с `libdeepseek.so`, `libnode.so`, `libc++_shared.so`,
metadata и `SHA256SUMS`.

Для упаковки перенесите три `.so` в `jniLibs/<ABI>/` и сохраните `libdeepseek.so` целиком,
вместе с секцией SEA. Launcher запускает соседний `libnode.so` из `nativeLibraryDir` после проверки
его SHA-256. Проверку `libdeepseek.so --verify --json` выполняют внутри Android с доступным
каталогом кэша. CI кросс-сборки проверяет файлы на Linux. Для приёмки запуска нужен Android.

## CLI

В терминале запустите `bin/grigdesk-dsh-ctl` без аргументов. Наведение мыши, колесо и стрелки
выбирают пункт и показывают его описание под списком. Enter или левый клик открывают пункт, Esc отменяет
ввод или закрывает меню. Сборка и проверка проекта показывают прогресс по завершённым
этапам, в том числе при прямом вызове из терминала. Полный вывод команды остаётся
в прокрутке терминала. После выполнения Enter или Esc возвращают к списку.

Для релиза меню по умолчанию готовит файлы локально. Допуск GLM и очистка кэша требуют
явного выбора. `NO_COLOR` убирает цвет. При перенаправлении ввода или вывода вызов без
аргументов показывает справку, а явные команды выводят текстовый журнал.

```
grigdesk-dsh-ctl build      [--out-dir <каталог>] [--binary-version <версия>]
                           [--require-admission] [--cache-dir <каталог>]
grigdesk-dsh-ctl verify     --binary <ELF>
grigdesk-dsh-ctl admit      --binary <ELF> --mode api|coding-plan [--admit] [--force] [--model <модель>]
grigdesk-dsh-ctl install    --binary <ELF> --target <путь> [--host-contract <файл>]
                           [--releases-dir <каталог>] [--glm-mode <режим>]
grigdesk-dsh-ctl release    --tag vX.Y.Z --binary <ELF> [--binary <ELF>...]
                           [--prerelease] [--notes <файл>] [--min-server-version <версия GrigDesk>]
                           [--sidecar] [--dry-run]
grigdesk-dsh-ctl publish-npm --tag vX.Y.Z [--registry <url>] [--dry-run]
grigdesk-dsh-ctl prune      [--cache-dir <каталог>] [--keep-builds N] [--keep-releases N]
grigdesk-dsh-ctl check
grigdesk-dsh-ctl help
```

`install` проверяет локальный кандидат в приватном промежуточном каталоге. Он сверяет
SHA-256, `--runtime-info`, полный `--verify` и контракт GrigDesk, сохраняет прежний
бинарник в `releases/<sha256>/` и атомарно заменяет файл. Следующие ходы используют
новую версию без перезапуска сервера.

## Терминальный чат

### Установка через npm

```bash
npm i -g @grigdesk/dsh
deepseek            # чат DeepSeek в текущей папке
glm                 # чат GLM (Z.ai)
qwen                # чат Qwen
```

Пакет в npm крошечный: `postinstall` скачивает ELF своей версии из GitHub Release
того же тега (`manifest.json` → asset платформы → SHA-256) и хранит версии рядом,
как Claude Code:

```
~/.local/share/grigdesk-dsh/versions/v1.2.3/deepseek   # ELF по версиям
~/.local/share/grigdesk-dsh/current -> versions/v1.2.3 # действующая версия
~/.local/bin/deepseek, glm, qwen                       # команды (ссылки на launcher'ы)
~/.deepseek/cli/…                                     # сессии и настройки терминального чата
```

GrigDesk находит ту же установку через `current/deepseek` и зовёт ELF с прежними
аргументами — терминал и приложение делят одну поставку и один распакованный runtime
в `~/.grigdesk/runtimes/deepseek/`. Без сети при установке помогает
`npm i -g --ignore-scripts @grigdesk/dsh && deepseek install`. Зеркало релизов —
`GRIGDESK_DEEPSEEK_DOWNLOAD_BASE`, другие каталоги — `GRIGDESK_DEEPSEEK_DATA_HOME`
и `GRIGDESK_DEEPSEEK_BIN_DIR`.

Публикация пакета идёт локально, как и допуск GLM: `grigdesk-dsh-ctl publish-npm --tag vX.Y.Z`
проверяет manifest релиза, собирает tarball с версией тега и выполняет `npm publish`
с токеном из `~/.npmrc`; prerelease уходит с dist-tag `next`. `--dry-run` показывает команду.

### Работа с чатом

Команды `deepseek`, `deepseek chat`, `glm` и `qwen` в терминале открывают чат в текущей
папке. Флаг `-C` выбирает папку, `-p` — поставщика, `-m` — модель, `--effort` — уровень
рассуждения, `--add-dir` — дополнительные области записи, `--schedule` — расписание GLM.
Терминал в фоне проверяет манифест стабильного выпуска и показывает в шапке ссылку,
если для его платформы есть более свежий бинарник. Результат хранится 20 часов
в `<кэш DSH>/updates/`. При закрытии чата активный запрос отменяется.
Флаг `--no-update-check` отключает проверку и уведомление на время запуска.
С `--mode read-only` доступны чтение и отклонение запросов на расширение прав.
В `workspace-write` Harness может работать в рабочей папке и запрашивать разовое разрешение.

| Подключение | Как задать доступ |
|---|---|
| DeepSeek API | `DEEPSEEK_API_KEY` |
| GLM API | `ZAI_API_KEY` и `-p glm --glm-mode api` |
| GLM Coding Plan | `ZAI_CODING_API_KEY` и `-p glm --glm-mode coding-plan` |
| Qwen | `QWEN_API_KEY` и `-p qwen --qwen-service model-studio` или `--qwen-service token-plan` |

Ключ не обязан жить в окружении: `deepseek login` (или `glm login`, `qwen login`) спрашивает
подключение, читает ключ скрыто, без эха и истории оболочки, и сохраняет его в
`~/.deepseek/credentials.json` с правами 0600. `deepseek login --status` показывает, откуда
взялся каждый ключ (последние четыре символа), `deepseek logout qwen` удаляет один ключ,
`--all` — все. Приоритет источника: переменная окружения терминала → `credentials.json` →
`.env` папки данных GrigDesk (`DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `ZAI_CODING_API_KEY`,
`DASHSCOPE_API_KEY` для Qwen). Файл GrigDesk только читается.

Для Qwen доступны Alibaba Model Studio (Сингапур) и QwenCloud Token Plan.
`QWEN_BASE_URL` указывает адрес другого региона или совместимого API. Если сервис
не отдаёт каталог `/models`, задайте `QWEN_MODELS` со списком через запятую либо `-m`
с ID одной модели. Ключи читаются из окружения текущего терминала.

Под полем ввода видны модель, уровень рассуждения, рабочая папка и начало последнего
запроса текущей сессии. После ответа чат показывает длительность хода.
Поле показывает до пяти строк черновика. `Alt+Enter` вставляет перевод строки,
многострочная вставка сохраняет переводы. Стрелки, `Home`, `End` и клик по полю
перемещают курсор. `↑`/`↓` на пустом поле возвращают отправленные запросы.
Запрос пользователя отмечен цветной подложкой и полосой слева. В ответах есть курсив,
жирное выделение, ссылки, вложенные списки, цитаты и таблицы. В узком окне таблица
показывает каждую запись списком полей. Блоки кода сохраняют отступы. Для JavaScript,
TypeScript, JSON, Python, Shell и YAML выделяются ключевые слова, значения и комментарии.
Соседние инструменты собраны вместе. Статус стоит перед именем, а число строк вывода
показывается справа. Левый клик по строке раскрывает вывод и длинную команду целиком.
`Tab` выбирает видимый блок, `Enter` переключает его, `Esc` возвращает фокус к полю.
`NO_COLOR=1` убирает цвет и атрибуты текста, сохраняя отступы и маркеры.
`/model` и `/effort` открывают список. Выберите пункт стрелками и `Enter`, левым кликом
или цифрой от 1 до 9. `Esc` закрывает список, сохраняя текущую настройку.
`PgUp`/`PgDn` и колесо мыши листают активный список или историю чата.
Экран рисуется в дополнительном буфере терминала без внешних зависимостей
(`src/launcher/tui/`): кадр всегда ровно по размеру терминала, между кадрами выводятся
только изменившиеся строки, недоверенный текст ответа и инструментов очищается от
escape-последовательностей. `/status` показывает модель, папку и ID сессии. `/resume`, `--resume ID` и `--last` продолжают сохранённую сессию
при том же подключении, режиме доступа и рабочей папке. `Ctrl+C` отменяет текущий ход,
`/exit` завершает чат. Сессии хранятся в `~/.deepseek` отдельно от переписки GrigDesk.
`GRIGDESK_DEEPSEEK_HOME` позволяет выбрать другой абсолютный путь этого каталога.

Терминальный GLM использует собственный каталог моделей и ключ поиска из
`GRIGDESK_GLM_SEARCH_API_KEY`. Доступны foreground и фоновые субагенты, результаты
и вопросы детей, `present`, `/goal` и `/plan`. В режиме записи доступны workflow и
Ralph. `--schedule` монтирует штатное расписание основной сессии. Её инструменты
показывают и меняют её собственные задачи. Используйте тот же каталог, режим и флаги
при `--resume` или `--last`. После открытия сессии Harness проверяет срок сохранённых
задач. Для отправки напоминаний требуется запущенный Harness. Вкладки и выданные
подключения приложения принадлежат GrigDesk.

Qwen использует собственный профиль. Персональные ключи остаются в окружении
соответствующего процесса. Во временный `--patch` попадают имена переменных.

## Ключи и `.env`

`admit` читает ключи по порядку: `GRIGDESK_DSH_ENV_FILE` → `.env` репозитория → `~/.grigdesk/.env`.
`process.loadEnvFile` не перекрывает уже заданные переменные.

| Переменная | Назначение |
|---|---|
| `ZAI_API_KEY` | Обычный API Z.ai (режим `api`) |
| `ZAI_CODING_API_KEY` | Coding Plan (режим `coding-plan`) |
| `GRIGDESK_GLM_API_MODE` | Режим потребителя для подсказок; сам `admit` требует явный `--mode` |

Ключ другого режима никогда не подставляется запасным. В окружение процесса Harness
попадает только `GRIGDESK_GLM_ROUTE_KEY`.

## Живая проверка и интеграция

Живой smoke здесь идёт **напрямую через ELF** (web-профиль, HTTP-RPC + WebSocket)
без серверного chat-модуля: ответ модели, правка маркера в workspace, resume сессии,
`turn/end completed`, отсутствие окончательных HTTP-ошибок Z.ai (`AUTH`, `QUOTA`,
бизнес-коды квоты). Это ровно то, что кодирует identity допуска.

Профиль smoke **не включает** `grigdesk:glm-gate` и серверные hooks: native gate ELF
на каждый инструмент вызывает helper политики GrigDesk, который живёт на сервере.
Серверную политику (SSH/DB deny, hooks-alive, approval, subagent lineage) доказывают
consumer-тесты GrigDesk против готового ELF (`GRIGDESK_TEST_DEEPSEEK_BINARY`).
Переносить серверную политику сюда означал бы два источника истины.

## Контракты

- `contracts/grigdesk-host-contract.json` — снимок `server/deepseek-host-contract.json`
  GrigDesk. Константы ревизий здесь не дублируются: `admissionCheck`, `admit` и
  установщик читают ревизии из контракта, поэтому сверка всегда идёт с потребителем.
  Обновляется при изменении контракта в GrigDesk.
- `manifest.json` релиза: `{ format, tag, createdAt, minServerVersion, hostContract,
  generation: { binaryVersion, upstreamVersion, sourceCommit, composition, dependencyLock },
  assets: [{ file, platform, arch, sha256, size, packageId, buildId, workerNode, capabilities,
  glm, …поля generation }] }` — по нему GrigDesk выбирает поставку и сверяет SHA-256 скачанного файла.
  `buildId` платформо-зависим (platform, arch, ABI, компилятор); общая identity generation —
  источник Harness, composition, dependency lock и ревизии GLM: они обязаны совпадать у всех
  assets одного тега, что и проверяет `release`.
- Stability: stable-тег требует допуск режима потребителя в metadata каждого ELF
  (`assertStableAdmission`) и по фактическому linux-x64 ELF; кандидат без допуска
  публикуется только как prerelease.
- В сборке по тегу настольный бинарник получает `binaryVersion` из тега поставки.
  Терминальный чат сравнивает этот номер со стабильным тегом, а `packageId`
  позволяет узнать свой бинарник, если его опубликовали под другим тегом.

## Перед push

```bash
npm run check:workflow     # YAML + bash -n каждого run-блока
bin/grigdesk-dsh-ctl release --tag vX.Y.Z-test --binary <ELF> --sidecar --dry-run
```

Правка публикации не требует пересборки: Actions → «Run workflow» с `run_id` готового
прогона и `tag` публикует его настольные артефакты (`workflow_dispatch`). Для старых прогонов
поддерживается комплект Linux и macOS. Комплекты Android скачиваются со страницы прогона.

## Проверки

```bash
npm run typecheck
npm run check:imports        # границы: ничего не импортируется за пределы репозитория
npm test                     # через сторож памяти; тяжёлые требуют подготовленный кэш
```

Настоящие ELF-сценарии против серверного клиента протокола (бывший `test:sea`)
остались в GrigDesk как consumer-тесты: они запускают готовый ELF через
`GRIGDESK_TEST_DEEPSEEK_BINARY` и проверяют серверную политику.

Тесты требуют `prepare:runtime` и `prepare:upstream`; сборка candidate занимает
несколько сотен МБ во `<cache>/artifacts/deepseek-binary`.

## Лицензия

[MIT](../LICENSE). Внутри payload — LICENSE worker Node, upstream LICENSE/THIRD_PARTY_NOTICES и
`build/licenses/` с npm/native notices.
