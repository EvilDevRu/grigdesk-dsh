# grigdesk-dsh

Автономная поставка [DeepSeek Harness](https://github.com/deepseek-ai/dsh) для GrigDesk:
один исполняемый файл `deepseek` с закреплённым worker Node, Harness, web/ACP-мостами,
плагином GLM, native-модулями и лицензиями. GrigDesk запускает его как исполнителя
DeepSeek и GLM и ничего о сборке не знает.

Репозиторий самодостаточен: сборка, проверка, живой smoke, публикация и установка
живут здесь. Сторож `scripts/checkImports.mts` запрещает импорты за пределы репозитория.

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
| `.github/workflows/dsh.yml` | Проверки, сборка ×3 платформ, GitHub Release |

## Быстрый старт

Нужны Node `^22.19.0 || >=24.0.0`, npm, git, tar/xz и C compiler с библиотеками native-зависимостей.

```bash
npm ci
npm run prepare:runtime      # pinned worker Node 24.22.3 + runtime deps в ~/.cache/grigdesk-dsh
npm run prepare:upstream      # снимок upstream Harness по upstream.lock.json
bin/grigdesk-dsh-ctl build        # ELF → ~/.cache/grigdesk-dsh/out/deepseek
```

`GRIGDESK_DSH_CACHE` задаёт абсолютный путь кэша вместо `~/.cache/grigdesk-dsh`.
Для `prepare:upstream` можно передать `--seed-dir <каталог>` (проверенная копия исходников)
или `--source-dir <git>` (локальный Git с нужным commit) — иначе сеть.

## Поток релиза

Допуск GLM — это вход сборки. Живой smoke требует ключи Z.ai, поэтому выполняется
**локально**, а CI собирает все платформы из уже зафиксированного `compatibility/glm.json`.

```
1. git tag v1.2.0-rc.1 && git push --tags
   → Actions: проверки, сборка linux-x64 / linux-arm64 / darwin-arm64, полный verify,
     pre-release GitHub с ELF и sidecar metadata (допуска может не быть)

2. локально:
   gh release download v1.2.0-rc.1 -p 'deepseek-linux-x64*' -D /tmp/dsh-rc
   bin/grigdesk-dsh-ctl admit --binary /tmp/dsh-rc/deepseek-linux-x64 --mode api --admit
   → identity по --runtime-info ELF → живой smoke (3 хода, HTTP-ошибки Z.ai)
   → запись {mode, compatibility} в compatibility/glm.json

   Допуск берётся на ELF **из rc-релиза**, а не на локальной сборке: identity включает
   hashes сборочных скриптов (`scripts/*.ts`), поэтому локально собранный другим коммитом
   ELF даст другой identity, чем CI. Правка любого файла из списка `deepSeekBuildInputs`
   требует нового admit.

3. коммит с glm.json → git tag v1.2.0 && git push --tags
   → Actions собирает три платформы уже с допуском; stable-гейт проверяет
     допуск по фактическому linux-x64 ELF и metadata каждого ELF; GitHub Release:
     deepseek-<platform>-<arch> ×3, manifest.json, sha256

4. GrigDesk: карточка поставки → установка штатным установщиком (см. ниже)
```

Identity допуска не зависит от платформы, пути и buildId — только входы Harness
(upstream commit, патчи, composition, dependency lock, исходник плагина), ревизии
профиля/политики из host-контракта и baseURL режима. Поэтому один smoke на Linux
допускает ELF всех платформ одной generation.

## CLI

В терминале запустите `bin/grigdesk-dsh-ctl` без аргументов. Стрелки выбирают пункт,
Enter открывает его, Esc отменяет ввод или закрывает меню. После выполнения команды
Enter или Esc возвращают к списку. Меню запрашивает пути и параметры, нужные выбранному
действию. Для релиза по умолчанию готовит файлы локально, допуск GLM и очистка кэша
требуют явного выбора. При перенаправлении ввода или вывода показывается справка.

```
grigdesk-dsh-ctl build      [--out-dir <каталог>] [--binary-version <версия>] [--require-admission]
grigdesk-dsh-ctl verify     --binary <ELF>
grigdesk-dsh-ctl admit      --binary <ELF> --mode api|coding-plan [--admit] [--force] [--model <модель>]
grigdesk-dsh-ctl install    --binary <ELF> --target <путь> [--host-contract <файл>]
                           [--releases-dir <каталог>] [--glm-mode <режим>]
grigdesk-dsh-ctl release    --tag vX.Y.Z --binary <ELF> [--binary <ELF>...]
                           [--prerelease] [--sidecar] [--notes <файл>]
grigdesk-dsh-ctl prune      [--keep-builds N] [--keep-releases N]
grigdesk-dsh-ctl check
grigdesk-dsh-ctl help
```

`install` вызывает тот же установщик, что и GrigDesk: приватный staging, SHA256,
`--runtime-info`, полный `--verify`, сверка с host-контрактом, атомарный rename,
резерв прежнего ELF в `releases/<sha256>/`. Совместимая замена не требует рестарта сервера.

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

## Что доказывает дым и что остаётся GrigDesk

Живой smoke здесь идёт **напрямую через ELF** (web-профиль, HTTP-RPC + WebSocket)
без серверного chat-модуля: ответ модели, правка маркера в workspace, resume сессии,
`turn/end completed`, отсутствие окончательных HTTP-ошибок Z.ai (`AUTH`, `QUOTA`,
бизнес-коды квоты). Это ровно то, что кодирует identity допуска.

Профиль smoke **не включает** `grigdesk:glm-gate` и серверные hooks: native gate ELF
на каждый инструмент вызывает helper политики GrigDesk, который живёт на сервере.
Серверную политику (SSH/DB deny, hooks-alive, approval, subagent lineage) доказывают
consumer-тесты GrigDesk против готового ELF (`GRIGDESK_DSH_TEST_BINARY`).
Переносить серверную политику сюда означал бы два источника истины.

## Контракты

- `contracts/grigdesk-host-contract.json` — снимок `server/deepseek-host-contract.json`
  GrigDesk. Константы ревизий здесь не дублируются: `admissionCheck`, `admit` и
  установщик читают ревизии из контракта, поэтому сверка всегда идёт с потребителем.
  Обновляется при изменении контракта в GrigDesk.
- `manifest.json` релиза: `{ format, tag, createdAt, minServerVersion, hostContract,
  generation: { binaryVersion, upstreamVersion, sourceCommit, composition, dependencyLock },
  assets: [{ file, platform, arch, sha256, size, packageId, buildId, workerNode, capabilities,
  glm, …поля generation }] }` — по нему GrigDesk выбирает поставку и проверяет downloaded sha256.
  `buildId` платформо-зависим (platform, arch, ABI, компилятор); общая identity generation —
  источник Harness, composition, dependency lock и ревизии GLM: они обязаны совпадать у всех
  assets одного тега, что и проверяет `release`.
- Stability: stable-тег требует допуск режима потребителя в metadata каждого ELF
  (`assertStableAdmission`) и по фактическому linux-x64 ELF; кандидат без допуска
  публикуется только как prerelease.

## Перед push

```bash
npm run check:workflow     # YAML + bash -n каждого run-блока
bin/grigdesk-dsh-ctl release --tag vX.Y.Z-test --binary <ELF> --sidecar --dry-run
```

Правка публикации не требует пересборки: Actions → «Run workflow» с `run_id` готового
прогона и `tag` публикует его артефакты (`workflow_dispatch`).

## Проверки

```bash
npm run typecheck
npm run check:imports        # границы: ничего не импортируется за пределы репозитория
npm test                     # через сторож памяти; тяжёлые требуют подготовленный кэш
```

Настоящие ELF-сценарии против серверного клиента протокола (бывший `test:sea`)
остались в GrigDesk как consumer-тесты: они запускают готовый ELF через
`GRIGDESK_DSH_TEST_BINARY` и проверяют серверную политику.

Тесты требуют `prepare:runtime` и `prepare:upstream`; сборка candidate занимает
несколько сотен МБ во `<cache>/artifacts/deepseek-binary`.

## Лицензия

MIT. Внутри payload — LICENSE worker Node, upstream LICENSE/THIRD_PARTY_NOTICES и
`build/licenses/` с npm/native notices.
