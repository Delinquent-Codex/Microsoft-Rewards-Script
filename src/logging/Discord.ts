import type { WebhookDiscordConfig } from '../interface/Config'
import type { LogLevel } from './Logger'
import { flushDiscordPremiumQueue, sendDiscordPremium } from './DiscordPremium'

// Keep compatibility with both call sites:
// - Logger passes the full Discord configuration object.
// - Cluster-primary IPC forwarding historically passes only the webhook URL.
// Remember the most recent full config so clustered worker messages retain the
// same presentation/privacy settings whenever possible.
let lastConfig: WebhookDiscordConfig | undefined

export async function sendDiscord(
    configOrUrl: WebhookDiscordConfig | string,
    content: string,
    level: LogLevel,
    webhookAllowed = true
): Promise<void> {
    let config: WebhookDiscordConfig

    if (typeof configOrUrl === 'string') {
        config =
            lastConfig && lastConfig.url === configOrUrl
                ? lastConfig
                : {
                      enabled: true,
                      url: configOrUrl,
                      mode: 'standard',
                      maskAccount: true,
                      includeWarnings: false,
                      respectWebhookFilter: false
                  }
    } else {
        config = configOrUrl
        lastConfig = configOrUrl
    }

    await sendDiscordPremium(config, content, level, webhookAllowed)
}

export function flushDiscordQueue(timeoutMs = 5000): Promise<void> {
    return flushDiscordPremiumQueue(timeoutMs)
}
