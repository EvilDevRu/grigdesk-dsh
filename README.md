<p align="center">
  <a href="https://dsh.grigdesk.com/">
    <picture>
      <source media="(max-width: 640px)" srcset="docs/images/readme/hero-mobile.svg">
      <img src="docs/images/readme/hero.svg" width="1280" alt="DeepSeek Harness for GrigDesk">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/EvilDevRu/grigdesk-dsh/releases">
    <img align="center" src="https://img.shields.io/github/v/release/EvilDevRu/grigdesk-dsh?label=version&amp;color=30363d" alt="Latest stable release">
  </a>
  <a href="https://github.com/EvilDevRu/grigdesk-dsh/actions/workflows/dsh.yml">
    <img align="center" src="https://github.com/EvilDevRu/grigdesk-dsh/actions/workflows/dsh.yml/badge.svg" alt="Build and checks">
  </a>
  <a href="LICENSE">
    <img align="center" src="https://img.shields.io/badge/license-MIT-30363d" alt="MIT license">
  </a>
</p>

<p align="center">
  <strong><a href="#install">Install</a></strong> &nbsp; / &nbsp;
  <a href="https://github.com/EvilDevRu/grigdesk-dsh/releases">Releases</a> &nbsp; / &nbsp;
  <a href="#documentation">Docs</a> &nbsp; / &nbsp;
  <a href="https://dsh.grigdesk.com/">DSH website</a>
</p>

<p align="center">
  One executable for DeepSeek, GLM (Z.ai), and Qwen in the terminal.<br>
  It bundles <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>,
  a pinned Node.js runtime, and the ACP and web integrations for GrigDesk.
</p>

## Install

### In GrigDesk

In a compatible version of GrigDesk, open **Settings → AI providers → Providers → DeepSeek or GLM → Overview**.
Select **Install** to download a compatible stable release for the server's platform.
DeepSeek and GLM share the installation and use separate access settings.

### Download the binary

Once a stable release is published, download the file for your platform from
[GitHub Releases](https://github.com/EvilDevRu/grigdesk-dsh/releases).

| Platform | Release asset |
| :--- | :--- |
| Linux x64 | [`deepseek-linux-x64`](https://github.com/EvilDevRu/grigdesk-dsh/releases/latest/download/deepseek-linux-x64) |
| Linux ARM64 | [`deepseek-linux-arm64`](https://github.com/EvilDevRu/grigdesk-dsh/releases/latest/download/deepseek-linux-arm64) |
| macOS on Apple Silicon | [`deepseek-darwin-arm64`](https://github.com/EvilDevRu/grigdesk-dsh/releases/latest/download/deepseek-darwin-arm64) |

<details>
<summary><strong>Verify a manual download</strong></summary>

Download the matching `.sha256` file into the same directory. For Linux x64, run:

```bash
sha256sum -c deepseek-linux-x64.sha256 &&
  chmod +x deepseek-linux-x64 &&
  ./deepseek-linux-x64 --verify --json
```

For Linux ARM64, use `deepseek-linux-arm64` in the commands above. On macOS, use
`shasum -a 256 -c deepseek-darwin-arm64.sha256` for the checksum and
`deepseek-darwin-arm64` for the executable.

</details>

## Терминальный чат

При первом запуске добавьте ключ через `deepseek login` или задайте переменную окружения своего подключения.
Для ручной установки укажите путь к бинарнику,
например `./deepseek-linux-x64 login` для настройки ключа и `./deepseek-linux-x64 chat` для чата.
Выберите подключение и режим доступа стрелками или левым кликом. Колесо мыши и `PgUp`/`PgDn` листают историю.
По умолчанию сессии и настройки чата хранятся в `~/.deepseek/cli/`. `/model` меняет модель, а `/effort`
выбирает уровень рассуждения, если модель его поддерживает. [Настройка чата](docs/development.md#терминальный-чат)

## Updates and compatibility

GrigDesk checks the release manifest for its platform, architecture, minimum server version, and host contract.
When a newer compatible release is available, choose **Update to …** in the provider card.
To restore the previous binary, choose **Roll back to …**.

Stable releases require GLM admission for the bundled runtime. Each release includes
`manifest.json` and a SHA-256 checksum for each binary.

Pushes to `main` and pull requests run type and import checks. Pushing a `v*` tag
runs the full tests and builds the release binaries.

В GLM `subagent` и `subagent_fork` ждут результат по умолчанию. Передайте
`run_in_background: true` для продолжимого запуска. Spawn позволяет выбрать модель
и усилие из каталога GLM. Fork сохраняет маршрут родителя.

## Documentation

Запустите `bin/grigdesk-dsh-ctl` без аргументов, чтобы открыть меню обслуживания.
Наведите мышь на пункт, выберите его стрелками или колесом, чтобы увидеть пояснение под списком.
Откройте пункт левым кликом или клавишей Enter.
Сборка и проверка проекта показывают прогресс по этапам.

| Topic | Where to look |
| :--- | :--- |
| GrigDesk setup and chats | [DeepSeek and GLM in GrigDesk][grigdesk-guide] |
| Build from source, use the terminal menu, test, and publish | [Development and releases (Russian)](docs/development.md) |
| Compatibility requirements for GrigDesk | [Host contract](contracts/grigdesk-host-contract.json) |
| GLM admission for this build | [Admission records](compatibility/glm.json) |
| Upstream source and pinned revision | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Upstream lock](vendor/deepseek-harness/upstream.lock.json) |

[grigdesk-guide]: https://github.com/EvilDevRu/grigdesk/blob/main/docs/grigdesk/guide/en/deepseek.md

## Contributing

Open a [GitHub issue](https://github.com/EvilDevRu/grigdesk-dsh/issues) to report a packaging or compatibility problem.
Include the release tag, platform, and output of `--runtime-info --json`. See the
[development guide](docs/development.md) for the checks to run before submitting a change.

## License

[MIT](LICENSE) © Dmitry Yurchenko. The release bundles the license notices for DeepSeek Harness, Node.js, and dependencies.
