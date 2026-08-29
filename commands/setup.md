---
description: Configure Discord Rich Presence branding for zcode-discord-rpc (optional custom application)
---

The plugin works out of the box with a built-in shared Discord application — no setup required. This command is only for users who want **custom branding** (their own application name and art). Respond in the user's language.

Steps:

1. Check the current configuration file (`~/.config/zcode-discord-rpc/config.json` on Linux/macOS, `%APPDATA%\zcode-discord-rpc\config.json` on Windows) and show which fields are set (mask the `client_id` value).
2. If the user wants custom branding, guide them:
   - Open https://discord.com/developers/applications → **New Application** → name it (this name is shown on the profile);
   - Copy the **Application ID** from General Information;
   - Write it into `client_id` in the config file (ask the user to paste it; never guess it);
   - Optionally upload art under **Rich Presence → Art Assets** and put the asset **name** into `large_image_key` (assets are referenced by name, and Discord clients cache asset lists per session — restart Discord after uploading).
3. Changes hot-reload: the daemon re-resolves `client_id` and assets within a few seconds, no restart needed.
4. Verify via `~/.cache/zcode-discord-rpc/daemon.log` (`%LOCALAPPDATA%\zcode-discord-rpc\daemon.log` on Windows) — expect a `client_id changed ... reconnecting` line followed by `connected to Discord`.

Arguments: $ARGUMENTS
