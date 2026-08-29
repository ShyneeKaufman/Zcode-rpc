# zcode-discord-rpc

[Русская версия](README.ru.md)

**Discord Rich Presence for [ZCode](https://z.ai).** Shows your current project and what the agent is doing right now in your Discord profile:

```
Playing ZCode
Working on my-project        ← workspace name
Running a shell command      ← live agent activity
44:12 elapsed                ← session timer
```

Activities reported: thinking (with an optional prompt preview), running tools (Bash, Edit, Read, Grep, Agent, …), waiting for permission, fixing tool errors, and idle ("Waiting for your input") between prompts.

## How it works

```
ZCode hooks ──► hooks/rpc-hook.mjs ──► state.json ──► bin/rpc-daemon.mjs ──► Discord IPC
(6 events)      (writes state file)                  (keeps a live connection)
```

- **Hooks** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`) write a tiny state file on every event.
- **Daemon** keeps a long-lived connection to Discord's local IPC socket (unix socket on Linux/macOS, named pipe on Windows) and applies presence updates. It reconnects automatically when Discord restarts, re-reads config changes on the fly, sends keepalive pings to detect dead connections, and clears the presence after `idle_timeout_min` minutes of inactivity.
- Duplicate events are fingerprinted and never re-sent, so Discord is not spammed.
- `tool_input` contents are **never** sent to Discord (secret-safe). The prompt preview is optional and truncated.

**Zero dependencies** — plain Node.js (the same runtime ZCode itself uses).

## Requirements

- [ZCode](https://z.ai) with plugin support
- Node.js (ZCode ships with one; any recent version works)
- Discord desktop app (**official Discord or Vesktop** both work) — running locally

## Install

Clone this repository, then register it as a local plugin dir in the ZCode user config `~/.zcode/cli/config.json` (on Windows: `%APPDATA%\.zcode\cli\config.json`):

```json
{
  "plugins": {
    "dirs": ["/path/to/zcode-discord-rpc"]
  }
}
```

Verify: `zcode plugins list` should show `zcode-discord-rpc@inline [enabled]` with `hooks: 6`. Restart your ZCode session (or just switch sessions) so the hooks register.

## Setup (one manual step)

Rich Presence requires a Discord **Application ID** — it is what Discord displays as the "playing …" title:

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it (e.g. "ZCode" — this name appears on your profile).
2. Copy the **Application ID** from the General Information page.
3. Put it into the config file and restart Discord once (the client caches the asset list per session).

Or run the `/zcode-discord-rpc:setup` slash command in ZCode and let the agent walk you through it.

Optional: upload an image under **Rich Presence → Art Assets** in the developer portal — its **key** goes into `large_image_key`. Important: the asset is referenced **by name** and Discord clients cache asset lists per session, so after uploading a new asset restart Discord once or the icon shows as "?".

> **Vesktop/Vencord users:** Vesktop's built-in arRPC bridge accepts any application ID, but the ID still must belong to a real application for the presence to display. The official Discord client always requires a real ID.

## Configuration

Config file location: `~/.config/zcode-discord-rpc/config.json` (Linux/macOS) or `%APPDATA%\zcode-discord-rpc\config.json` (Windows). Both can be overridden with the `ZCODE_DISCORD_RPC_DIR` env var (config and runtime files share that directory then).

| Field | Default | Description |
|---|---|---|
| `client_id` | `""` | Discord Application ID. Empty = presence disabled. Hot-reloaded. |
| `large_image_key` | `"zcode"` | Art asset **name** for the large icon (`none` hides it). |
| `large_image_text` | `"ZCode CLI"` | Tooltip for the large icon. |
| `small_image_key` | `""` | Art asset name for the small icon (empty = hidden). |
| `show_prompt` | `true` | Show the first line of your prompt as the status text. |
| `max_prompt_len` | `80` | Prompt preview length limit. |
| `idle_timeout_min` | `60` | Minutes without activity before the presence is cleared. |

Runtime files: `~/.cache/zcode-discord-rpc/` (Linux/macOS) or `%LOCALAPPDATA%\zcode-discord-rpc\` (Windows): `state.json`, `daemon.pid`, `daemon.log`, `hook-trace.log`.

## Troubleshooting

- `tail -f ~/.cache/zcode-discord-rpc/daemon.log` (or the Windows path above) — expect `daemon started` and `connected to Discord`. Connect failures and RPC errors are logged here.
- `hook-trace.log` shows every hook invocation — useful to verify hooks fire.
- Presence missing entirely: check that `client_id` is a **real** application ID (Discord silently drops unknown IDs), and that `zcode plugins list` shows the plugin enabled with `hooks: 6`.
- Icon shows as "?": restart Discord after uploading the asset, and make sure `large_image_key` is the asset **name** (not its numeric ID).
- Stop the daemon: `kill $(cat <runtime dir>/daemon.pid)` — it respawns on the next session event.
- Manual hook test:
  ```bash
  printf '%s\n' '{"hook_event_name":"PreToolUse","session_id":"t1","cwd":"/tmp/proj","tool_name":"Bash"}' \
    | node hooks/rpc-hook.mjs
  ```

## Limitations

- Multiple parallel ZCode sessions share one presence (last event wins).
- The "playing" title is your Discord application's name.
- Hooks register on session start/resume — after installing the plugin mid-session, switch or restart the session.
- The `Stop` hook of a session started before v1.1.0 may still reference the old Python hook; a compatibility shim (`hooks/rpc-hook.py`) is included and safely delegates to the Node implementation.

## License

[MIT](LICENSE)
