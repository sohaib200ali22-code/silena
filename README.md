# Silena

Silena is a private, single-server Discord moderation bot. Every slash command is restricted at runtime to the configured `OWNER_ID`, must be used in `GUILD_ID`, and also checks the owner's required server permission and Silena's required bot permission. Commands are registered as guild commands for that one server. If Silena is already in, or is later added to, another server, it attempts to leave that server and logs the event.

## Configuration

Copy `.env.example` to `.env` for local use and fill in the four required values:

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal. Keep it secret. |
| `CLIENT_ID` | Application ID from the Developer Portal. |
| `GUILD_ID` | The one Discord server where Silena is allowed to operate. |
| `OWNER_ID` | The Discord user ID allowed to run Silena's commands. |

Enable the **Message Content Intent** for the bot in the Developer Portal so automod can inspect message text. Silena does not request the privileged Server Members Intent; moderation commands fetch individual target members as needed. Invite it to the configured server with the `bot` and `applications.commands` OAuth scopes and only the permissions it needs: View Channels, Read Message History, Send Messages, Manage Messages, Manage Channels, Moderate Members, Kick Members, and Ban Members. The command runner also checks the caller's corresponding Manage Messages, Manage Channels, Moderate Members, Kick Members, or Ban Members permission.

Configuration is validated on startup and command deployment. Discord IDs must be 17-20 digit IDs. Never commit `.env` or put a real token in source control.

## Moderation and automod

Commands: `/clear`, `/lock`, `/unlock`, `/timeout`, `/warn`, `/kick`, and `/ban`. `/clear` without a user still deletes the requested 1-100 recent messages. With a user selected, it scans at most the latest 1,000 messages in the current channel, previews the match count, and requires confirmation before deleting matches. An optional amount caps how many matching messages are deleted (up to 1,000); messages older than 14 days are deleted individually, while newer matches are bulk deleted. The result reports scanned, matched, deleted, skipped (non-matches or matches beyond the cap), and failed counts. Lock and unlock apply only to the current text channel (not threads or voice channels) and change only the `@everyone` `SendMessages` override. Unlock removes that override so the channel inherits its category/server policy; it does not force the channel open if the category remains locked. Moderation actions include a reason where supported and are written to the process logs; Discord's own audit log receives reasons for individual deletions, timeouts, kicks, bans, and channel permission changes. `/warn` is a logged, visible warning only; warnings are not stored as a case history.

Automod removes configured invite links, `@everyone`/`@here` and messages with more than five user/role mentions, and bursts above the configured message threshold. It does not automatically timeout or ban users. Server administrators and the configured bot owner are exempt from automod. Defaults and environment controls:

| Variable | Default | Behavior |
| --- | --- | --- |
| `BLOCK_INVITES` | `true` | Remove Discord invite links. |
| `BLOCK_LINKS` | `false` | Also remove ordinary HTTP(S) and `www` links. |
| `SPAM_MAX_MESSAGES` | `5` | Maximum messages per user before the next message is removed (3-20). |
| `SPAM_WINDOW_SECONDS` | `8` | Rolling interval for the spam threshold (3-60 seconds). |

## Local development

```sh
npm install
npm test
npm start
```

On Discord client startup, Silena registers its slash commands to the configured guild and logs the number registered. `npm run deploy:commands` is also available for manual registration and updates only that guild's command set. Keep the bot token private and do not run multiple bot instances with the same configuration unless you intend them to share the same gateway connection.

## Render

The included `render.yaml` defines Silena as a long-running Node background worker. Create or update the service from the Blueprint and set `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, and `OWNER_ID` in Render's environment settings; the Blueprint deliberately does not contain secret values. Set optional automod variables there if you want different defaults. Render runs `npm ci` to build and `npm start` to launch the bot. Once Discord login succeeds, Silena registers slash commands in `GUILD_ID`; confirm logs show `slash_commands_registered` with the expected command count.

Silena also starts an Express health endpoint at `GET /health` on `0.0.0.0:$PORT` (default port `10000`). It returns HTTP 200 when the Discord client is connected and 503 while it is starting. Render background workers do not expose inbound HTTP traffic or use web-service health checks, so this endpoint is not required for the current worker deployment; it is available if you later run Silena as a Render Web Service. An HTTP listener failure is logged but does not prevent Discord login.

If registration fails, inspect Render logs for `slash_command_registration_failed` and verify that `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID` all refer to the same Discord application/server setup and that the bot is installed in that guild with the `applications.commands` scope. Do not deploy or paste the token into source files or logs.

## Possible future commands

Useful next additions could include `/slowmode` with a bounded duration, persistent warning history and lookup, or configurable automod exemptions for trusted roles/channels.
