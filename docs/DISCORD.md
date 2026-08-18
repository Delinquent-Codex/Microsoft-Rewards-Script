# Enhanced Discord notifications

This fork includes a lightweight Discord notification layer designed for long-running Docker/Render deployments.

## Required settings

Set these environment variables:

```env
CONFIG_DISCORD_ENABLED=true
CONFIG_DISCORD_URL=https://discord.com/api/webhooks/...
```

Treat the webhook URL like a password. Anyone with the URL can post to the channel.

## Recommended Render settings

```env
CONFIG_DISCORD_MODE=standard
CONFIG_DISCORD_USERNAME=Microsoft Rewards
CONFIG_DISCORD_MASK_ACCOUNT=true
CONFIG_DISCORD_INCLUDE_WARNINGS=false
CONFIG_DISCORD_RESPECT_WEBHOOK_FILTER=false
CONFIG_DISCORD_DASHBOARD_URL=https://your-dashboard.example.com
```

`CONFIG_DISCORD_DASHBOARD_URL` is optional. When set to an HTTP/HTTPS URL, Discord embed titles link to the dashboard.

## Notification modes

### `summary`

Minimal daily status:

- run started
- account completed
- run completed
- all errors

Good for quiet channels.

### `standard` (recommended)

Adds useful milestones without individual activity spam:

- run started
- account started
- daily points availability
- Daily Set completion
- More Promotions completion
- Daily Check-In completion
- App Promotions completion
- Read to Earn completion
- completed punchcards
- search summary
- bonus-points claim
- account earnings summary
- account completion
- run completion
- all errors

### `verbose`

Sends nearly every non-debug log line as a structured Discord embed. Use this only for troubleshooting because it can produce many messages.

## Optional settings

| Environment variable                    | Default             | Purpose                                                           |
| --------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `CONFIG_DISCORD_MODE`                   | `standard`          | `summary`, `standard`, or `verbose`                               |
| `CONFIG_DISCORD_USERNAME`               | `Microsoft Rewards` | Webhook display name                                              |
| `CONFIG_DISCORD_AVATAR_URL`             | empty               | Optional HTTP/HTTPS webhook avatar                                |
| `CONFIG_DISCORD_DASHBOARD_URL`          | empty               | Optional dashboard link attached to embed titles                  |
| `CONFIG_DISCORD_MASK_ACCOUNT`           | `true`              | Masks account email addresses in embeds and error text            |
| `CONFIG_DISCORD_INCLUDE_WARNINGS`       | `false`             | Includes selected warnings; verbose mode can include all warnings |
| `CONFIG_DISCORD_RESPECT_WEBHOOK_FILTER` | `false`             | If true, the generic webhook log filter is also required to pass  |

These advanced settings are read directly from the process environment, which makes them suitable for Render environment variables without requiring config-file persistence.

## Privacy and safety

The Discord formatter:

- disables Discord mentions (`@everyone`, roles, users)
- masks account email addresses by default
- redacts Bearer credentials and common token/secret query parameters from notification text
- truncates oversized embed fields and descriptions to Discord-safe limits
- never intentionally includes the configured Discord webhook URL

Do not place Microsoft passwords, TOTP setup secrets, API tokens, or Discord webhook URLs in log messages.

## Reliability

Discord delivery uses:

- a single-concurrency queue to preserve message order
- a conservative per-second rate limit
- short duplicate suppression for repeated identical messages
- retry/backoff for HTTP 429 and temporary 5xx responses
- bounded in-memory dedupe state (maximum 100 recent entries)

This keeps notification overhead small for low-memory hosts such as Render Free.

## Recommended production profile

For normal daily use:

```env
CONFIG_DISCORD_ENABLED=true
CONFIG_DISCORD_MODE=standard
CONFIG_DISCORD_MASK_ACCOUNT=true
CONFIG_DISCORD_INCLUDE_WARNINGS=false
CONFIG_DISCORD_RESPECT_WEBHOOK_FILTER=false
```

For troubleshooting a failed run temporarily:

```env
CONFIG_DISCORD_MODE=verbose
CONFIG_DISCORD_INCLUDE_WARNINGS=true
```

Return to `standard` when troubleshooting is complete.
