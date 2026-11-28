# @grigdesk/deepseek

Terminal commands for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as shipped by
[GrigDesk](https://app.grigdesk.com): one pinned runtime, three commands.

```bash
npm i -g @grigdesk/deepseek

deepseek        # DeepSeek chat in the current directory
glm             # GLM (Z.ai) chat
qwen            # Qwen chat
```

The package itself is tiny. `postinstall` downloads the standalone binary for your platform from the
[GitHub release](https://github.com/EvilDevRu/grigdesk-dsh/releases) of the same version, verifies its
SHA-256 against `manifest.json`, and keeps every version side by side:

```
~/.local/share/grigdesk-dsh/versions/v1.2.3/deepseek   # binary
~/.local/share/grigdesk-dsh/current -> versions/v1.2.3
~/.local/bin/deepseek, glm, qwen                       # command links
~/.deepseek/                                          # terminal chat sessions and settings
```

Supported platforms: Linux x64, Linux ARM64, macOS on Apple Silicon.

The chat checks for stable releases in the background and links to available updates in the header.
Use `npm i -g @grigdesk/deepseek@latest` to upgrade, or `deepseek chat --no-update-check` to skip the check.

## API keys

```bash
deepseek login        # pick a provider, paste the key (hidden input) → ~/.deepseek/credentials.json (0600)
deepseek login --status
deepseek logout qwen
```

Keys are resolved in this order: the terminal environment (`DEEPSEEK_API_KEY`, `ZAI_API_KEY` or
`ZAI_CODING_API_KEY` for GLM API / Coding Plan, `QWEN_API_KEY`) → `~/.deepseek/credentials.json` →
the `.env` file of an installed GrigDesk (its Qwen key is `DASHSCOPE_API_KEY`; the file is only read).

## Without network at install time

```bash
npm i -g --ignore-scripts @grigdesk/deepseek
deepseek install      # downloads later; repeat any time
```

## Options

| Variable | Purpose |
| :--- | :--- |
| `GRIGDESK_DEEPSEEK_DOWNLOAD_BASE` | Mirror of release assets (HTTPS, or HTTP on loopback for testing) |
| `GRIGDESK_DEEPSEEK_DATA_HOME` | Where versions live (default `~/.local/share/grigdesk-dsh`) |
| `GRIGDESK_DEEPSEEK_BIN_DIR` | Where command links are created (default `~/.local/bin`) |

GrigDesk finds the same installation through `current/deepseek`, so the terminal and the app share one
runtime. MIT — see the repository license.
