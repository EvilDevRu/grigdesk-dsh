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

### Terminal via npm

Install with Node.js 18.18 or later once the npm package and its matching GitHub release are published.
For an unpublished build, see [Build from source](docs/development.md#быстрый-старт).

```bash
npm i -g @grigdesk/deepseek
```

The installer downloads the standalone binary for your platform and verifies its SHA-256 against `manifest.json`.
The npm installer supports Linux x64, Linux ARM64, and macOS on Apple Silicon.
By default, it keeps binaries under `~/.local/share/grigdesk-dsh/` and adds command links to `~/.local/bin`.
See the [npm package documentation](npm/README.md) for mirrors and custom install paths.

### In GrigDesk

In a compatible version of GrigDesk, open **Settings → AI providers → Providers → DeepSeek or GLM → Overview**.
Select **Install** to download a compatible stable release for the server's platform.
DeepSeek and GLM share the installation and use separate access settings.

### Download the binary

Once a stable release is published, download desktop binaries from
[GitHub Releases](https://github.com/EvilDevRu/grigdesk-dsh/releases).

| Platform | Download |
| :--- | :--- |
| Linux x64 | [`deepseek-linux-x64`](https://github.com/EvilDevRu/grigdesk-dsh/releases/latest/download/deepseek-linux-x64) |
| Linux ARM64 | [`deepseek-linux-arm64`](https://github.com/EvilDevRu/grigdesk-dsh/releases/latest/download/deepseek-linux-arm64) |
| macOS on Apple Silicon | [`deepseek-darwin-arm64`](https://github.com/EvilDevRu/grigdesk-dsh/releases/latest/download/deepseek-darwin-arm64) |
| Windows x64 | [`deepseek-win32-x64.exe`](https://github.com/EvilDevRu/grigdesk-dsh/releases/latest/download/deepseek-win32-x64.exe) |
| Windows ARM64 | [`deepseek-win32-arm64.exe`](https://github.com/EvilDevRu/grigdesk-dsh/releases/latest/download/deepseek-win32-arm64.exe) |
| Android ARM64 (`arm64-v8a`) | [`android-dsh-arm64-v8a`](#android-bundles) |
| Android x86_64 | [`android-dsh-x86_64`](#android-bundles) |

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

On Windows, compare the output of `Get-FileHash .\deepseek-win32-x64.exe -Algorithm SHA256`
with the `.sha256` file, then run `.\deepseek-win32-x64.exe --verify --json`.
For Windows ARM64, use `deepseek-win32-arm64.exe` in both commands.

</details>

### Android bundles

Open the workflow run for the `v*` tag you need and download the bundle for your architecture
from **Artifacts**. Each bundle contains the `.so` libraries for APK packaging and a `SHA256SUMS` file.
[GitHub Actions runs](https://github.com/EvilDevRu/grigdesk-dsh/actions/workflows/dsh.yml) ·
[APK packaging guide (Russian)](docs/development.md#комплекты-android)

<a name="терминальный-чат"></a>

## Terminal chat

On first use, add an API key with `deepseek login` or set the environment variable for your connection.
Run `deepseek`, `glm`, or `qwen` from your project directory. If you downloaded the binary manually,
use its path, for example `./deepseek-linux-x64 login` to set up the key and `./deepseek-linux-x64 chat`
to open a chat. Use the arrow keys or left-click to select a connection and access mode.
Scroll through the conversation with the mouse wheel or `PgUp` and `PgDn`.
Your prompts are marked by a tinted panel with a left rail. Replies render Markdown tables, quotes,
and fenced code as distinct blocks. Consecutive tool calls stay together, with each call's status
on the left and its output line count on the right. Click a tool row to show or hide its details.
You can also select a visible row with `Tab`, toggle it with `Enter`, and return to the composer with `Esc`.
Use `Alt+Enter` or paste to enter multiple lines. The footer shows the model,
reasoning effort, working directory, and current prompt. Set `NO_COLOR=1` to remove
colors and text styling.
Sessions and chat settings are stored in `~/.deepseek/cli/` by default. Use `/model` to change the model
and `/effort` to set reasoning effort when the model supports it. [Chat setup (Russian)](docs/development.md#терминальный-чат)

## Updates and compatibility

The terminal chat checks for stable releases in the background. The header shows a link when a newer
release has a binary for your platform. Checks use a 20-hour cache. Use `deepseek chat --no-update-check`
to skip the check for a session. To upgrade an npm installation, run `npm i -g @grigdesk/deepseek@latest`.

GrigDesk checks the release manifest for its platform, architecture, minimum server version, and host contract.
When a newer compatible release is available, choose **Update to …** in the provider card.
To restore the previous binary, choose **Roll back to …**.

Stable releases require GLM admission for the bundled runtime. Each release includes
`manifest.json` and a SHA-256 checksum for each binary.

Pushes to `main` and pull requests run type and import checks. Pushing a `v*` tag
runs the full tests and builds the release binaries for Linux, macOS, and Windows.
The same workflow run builds the [Android bundles](#android-bundles).

In GLM, `subagent` and `subagent_fork` wait for a result by default. Set `run_in_background: true`
to let the subagent run in the background. When spawning an agent, you can choose its model
and reasoning effort from the GLM catalog. A fork inherits its parent's model route.

For GrigDesk-managed GLM schedules, the ELF advertises `glmManagedSchedule`.
GrigDesk opens the target session under current permissions and authorizes each
occurrence through its private Harness connection. The terminal flag
`deepseek chat -p glm --mode workspace-write --schedule` uses the native timer
in the open terminal session.

## Documentation

Run `bin/grigdesk-dsh-ctl` without arguments to open the maintenance menu. Hover over an item
or select it with the arrow keys or mouse wheel to see its description below the list.
Open the selected item with a left click or Enter. Build and check commands show progress for each step.

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
