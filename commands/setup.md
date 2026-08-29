---
description: Set up Discord Rich Presence for ZCode (help create a Discord app and configure client_id)
---

Help the user finish configuring the `zcode-discord-rpc` plugin. Respond in the user's language.

Steps:

1. Check the current configuration file at `~/.config/zcode-discord-rpc/config.json` and show which fields are set (never print the full `client_id`, mask it).
2. Explain that Rich Presence needs a Discord application ID. Guide the user through it:
   - Open https://discord.com/developers/applications and click **New Application**;
   - Name it (e.g. "ZCode" — this name is shown on the Discord profile);
   - Copy the **Application ID** from the General Information page.
3. Offer to write the ID into `~/.config/zcode-discord-rpc/config.json` as `client_id` (ask the user to paste it; do not guess it).
4. Optionally upload an image asset named `zcode` in the application's **Rich Presence → Art Assets** page — it becomes the large cover image. Without it the presence works but shows no image.
5. Make sure the Discord desktop app is running, then verify the daemon: `cat ~/.cache/zcode-discord-rpc/daemon.log` (or the log path printed by the plugin README). The log should show `connected to Discord`.
6. If `client_id` was just set while a session was already running, tell the user it will be picked up automatically within a few seconds, or after the next prompt in the worst case.

Arguments: $ARGUMENTS
