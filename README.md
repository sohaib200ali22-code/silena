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

Enable the **Message Content Intent** for the bot in the Developer Portal so automod can inspect message text. Silena does not request the privileged Server Members Intent; moderation commands fetch individual target members as needed. Invite it to the configured server with the `bot` and `applications.commands` OAuth scopes and only the permissions it needs: View Channels, Read Message History, Send Messages, Manage Messages, Moderate Members, Kick Members, and Ban Members. The command runner also checks the caller's corresponding Manage Messages, Moderate Members, Kick Members, or Ban Members permission.

Configuration is validated on startup and command deployment. Discord IDs must be 17-20 digit IDs. Never commit `.env` or put a real token in source control.

## Moderation and automod

Commands: `/clear`, `/timeout`, `/warn`, `/kick`, and `/ban`. Moderation actions include a reason where supported and are written to the process logs; Discord's own audit log receives reasons for timeouts, kicks, and bans. `/warn` is a logged, visible warning only; warnings are not stored as a case history.

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
npm run deploy:commands
npm start
```

Register commands after setting all four required environment variables. `deploy:commands` updates only the configured guild's command set. Keep the bot token private and do not run multiple bot instances with the same configuration unless you intend them to share the same gateway connection.

## Render

The included `render.yaml` defines Silena as a long-running Node background worker. Create or update the service from the Blueprint and set `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, and `OWNER_ID` in Render's environment settings; the Blueprint deliberately does not contain secret values. Set optional automod variables there if you want different defaults. Render runs `npm ci` to build and `npm start` to launch the bot.

Register slash commands separately with `npm run deploy:commands` from a trusted machine configured with the same environment variables, or through an appropriately configured one-off environment. Do not deploy or paste the token into source files or logs.
