import { httpRequest } from '../util/Http'
import type { HttpRequestConfig, HttpResponse } from '../util/Http'
import PQueue from 'p-queue'
import type { DiscordNotificationMode, WebhookDiscordConfig } from '../interface/Config'
import type { LogLevel } from './Logger'
import { flushQueue } from './Queue'

const EMBED_DESCRIPTION_LIMIT = 4000
const EMBED_FIELD_LIMIT = 1024
const DEDUPE_WINDOW_MS = 30_000
const MAX_RECENT_NOTIFICATIONS = 100
const MAX_SEND_ATTEMPTS = 3

interface ParsedLog {
    timestamp: string
    account: string
    level: LogLevel
    platform: 'MAIN' | 'MOBILE' | 'DESKTOP'
    event: string
    message: string
}

interface DiscordField {
    name: string
    value: string
    inline?: boolean
}

interface DiscordEmbed {
    title: string
    description?: string
    url?: string
    color: number
    fields?: DiscordField[]
    footer?: { text: string }
    timestamp?: string
}

interface ResolvedDiscordSettings {
    mode: DiscordNotificationMode
    username: string
    avatarUrl?: string
    dashboardUrl?: string
    maskAccount: boolean
    includeWarnings: boolean
    respectWebhookFilter: boolean
}

const discordQueue = new PQueue({
    concurrency: 1,
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

const recentNotifications = new Map<string, number>()

function truncate(text: string, limit = EMBED_DESCRIPTION_LIMIT) {
    return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 14)) + ' …(truncated)'
}

const LEVEL_COLOR: Record<LogLevel, number> = {
    error: 0xed4245,
    warn: 0xfee75c,
    info: 0x5865f2,
    debug: 0x4f545c
}

const SUCCESS_COLOR = 0x57f287
const POINTS_COLOR = 0xf1c40f
const SEARCH_COLOR = 0x3498db
const ACTIVITY_COLOR = 0x9b59b6

const EVENT_TITLES: Record<string, string> = {
    'RUN-START': 'Rewards Run Started',
    'RUN-END': 'Rewards Run Complete',
    'ACCOUNT-START': 'Account Started',
    'ACCOUNT-END': 'Account Complete',
    POINTS: 'Points Available',
    FLOW: 'Rewards Progress',
    'DAILY-SET': 'Daily Set',
    'MORE-PROMOTIONS': 'More Promotions',
    'DAILY-CHECK-IN': 'Daily Check-In',
    'APP-PROMOTIONS': 'App Promotions',
    'READ-TO-EARN': 'Read to Earn',
    PUNCHCARD: 'Punchcard',
    'SEARCH-MANAGER': 'Search Manager',
    'CLAIM-BONUS-POINTS': 'Bonus Points',
    'SEARCH-ON-BING-SEARCH': 'Explore on Bing',
    'LOGIN-BING': 'Bing Session',
    LOGIN: 'Microsoft Login'
}

const SUMMARY_EVENTS = new Set(['RUN-START', 'ACCOUNT-END', 'RUN-END'])

function parseLog(content: string, fallbackLevel: LogLevel): ParsedLog | null {
    const match = content.match(
        /^\[(.*?)\] \[(.*?)\] \[(INFO|WARN|ERROR|DEBUG)\] (MAIN|MOBILE|DESKTOP) \[(.*?)\] ([\s\S]*)$/
    )
    if (!match) return null

    return {
        timestamp: match[1] ?? '',
        account: match[2] ?? 'MAIN',
        level: ((match[3] ?? fallbackLevel).toLowerCase() as LogLevel) || fallbackLevel,
        platform: (match[4] ?? 'MAIN') as ParsedLog['platform'],
        event: match[5] ?? 'LOG',
        message: match[6] ?? ''
    }
}

function humanizeEvent(event: string): string {
    if (EVENT_TITLES[event]) return EVENT_TITLES[event]
    return event
        .replace(/[-_]+/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, char => char.toUpperCase())
}

function maskEmail(value: string): string {
    const at = value.indexOf('@')
    if (at <= 0) return value
    const local = value.slice(0, at)
    const domain = value.slice(at + 1)
    const visible = local.slice(0, Math.min(2, local.length))
    return `${visible}${local.length > visible.length ? '***' : ''}@${domain}`
}

function displayAccount(account: string, shouldMask: boolean): string {
    if (!account || account === 'MAIN') return 'Main process'
    return shouldMask ? maskEmail(account) : account
}

function sanitizeText(text: string, maskEmails = true): string {
    let out = text
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(
            /([?&](?:access_token|refresh_token|id_token|token|secret|code|assertion|session|auth)=)[^&#\s]+/gi,
            '$1[redacted]'
        )
        .replace(/((?:access_token|refresh_token|id_token|token|secret|assertion)\s*[=:]\s*)[^|,;\s]+/gi, '$1[redacted]')

    if (maskEmails) {
        out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, value => maskEmail(value))
    }

    return out
}

function metric(message: string, key: string): string | undefined {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = message.match(new RegExp(`(?:^|\\|)\\s*${escaped}=([^|]+)`, 'i'))
    return match?.[1]?.trim()
}

function colonMetric(message: string, key: string): string | undefined {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = message.match(new RegExp(`(?:^|\\|)\\s*${escaped}:\\s*([^|]+)`, 'i'))
    return match?.[1]?.trim()
}

function addField(fields: DiscordField[], name: string, value: string | undefined, inline = true): void {
    if (!value) return
    fields.push({ name, value: truncate(value, EMBED_FIELD_LIMIT), inline })
}

function toIsoTimestamp(value: string): string | undefined {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return fallback
    if (raw === 'true') return true
    if (raw === 'false') return false
    return fallback
}

function safeHttpUrl(value: string | undefined): string | undefined {
    if (!value) return undefined
    try {
        const url = new URL(value)
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
    } catch {
        return undefined
    }
}

function resolveMode(value: string | undefined, fallback: DiscordNotificationMode): DiscordNotificationMode {
    return value === 'summary' || value === 'standard' || value === 'verbose' ? value : fallback
}

function resolveSettings(config: WebhookDiscordConfig): ResolvedDiscordSettings {
    const configuredMode = config.mode ?? 'standard'
    const mode = resolveMode(process.env.CONFIG_DISCORD_MODE, configuredMode)

    return {
        mode,
        username: truncate(process.env.CONFIG_DISCORD_USERNAME || config.username || 'Microsoft Rewards', 80),
        avatarUrl: safeHttpUrl(process.env.CONFIG_DISCORD_AVATAR_URL || config.avatarUrl),
        dashboardUrl: safeHttpUrl(process.env.CONFIG_DISCORD_DASHBOARD_URL || config.dashboardUrl),
        maskAccount: parseBooleanEnv('CONFIG_DISCORD_MASK_ACCOUNT', config.maskAccount ?? true),
        includeWarnings: parseBooleanEnv('CONFIG_DISCORD_INCLUDE_WARNINGS', config.includeWarnings ?? false),
        respectWebhookFilter: parseBooleanEnv(
            'CONFIG_DISCORD_RESPECT_WEBHOOK_FILTER',
            config.respectWebhookFilter ?? false
        )
    }
}

function isStandardMilestone(parsed: ParsedLog): boolean {
    if (SUMMARY_EVENTS.has(parsed.event)) return true

    switch (parsed.event) {
        case 'ACCOUNT-START':
        case 'POINTS':
            return true
        case 'DAILY-SET':
            return parsed.message.startsWith('All ') || parsed.message.startsWith('Finished processing')
        case 'MORE-PROMOTIONS':
        case 'APP-PROMOTIONS':
            return parsed.message.startsWith('Finished processing')
        case 'DAILY-CHECK-IN':
        case 'READ-TO-EARN':
        case 'CLAIM-BONUS-POINTS':
            return parsed.message.startsWith('Completed')
        case 'PUNCHCARD':
            return /\bCOMPLETE\b/.test(parsed.message)
        case 'SEARCH-MANAGER':
            return parsed.message.startsWith('Search summary')
        case 'FLOW':
            return parsed.message.startsWith('Points collected')
        default:
            return false
    }
}

function isImportantWarning(parsed: ParsedLog): boolean {
    return (
        (parsed.event === 'SEARCH-ON-BING-SEARCH' && parsed.message.includes('Skipping incompatible SearchOnBing offer')) ||
        parsed.message.includes('heap out of memory') ||
        parsed.message.includes('memory limit')
    )
}

function shouldSend(
    parsed: ParsedLog | null,
    level: LogLevel,
    settings: ResolvedDiscordSettings,
    webhookAllowed: boolean
): boolean {
    if (settings.respectWebhookFilter && !webhookAllowed) return false
    if (level === 'error' || parsed?.level === 'error') return true

    if (!parsed) {
        if (level === 'warn') return settings.includeWarnings
        return settings.mode === 'verbose'
    }

    if (parsed.level === 'warn') {
        if (isImportantWarning(parsed)) return settings.includeWarnings
        return settings.mode === 'verbose' && settings.includeWarnings
    }

    if (settings.mode === 'summary') return SUMMARY_EVENTS.has(parsed.event)
    if (settings.mode === 'standard') return isStandardMilestone(parsed)
    return parsed.level !== 'debug'
}

function makeNotificationKey(parsed: ParsedLog | null, content: string, level: LogLevel): string {
    const event = parsed?.event ?? 'RAW'
    const body = parsed?.message ?? content
    return `${level}|${event}|${sanitizeText(body).slice(0, 300)}`
}

function isDuplicate(key: string): boolean {
    const now = Date.now()
    const previous = recentNotifications.get(key)
    recentNotifications.set(key, now)

    for (const [existingKey, seenAt] of recentNotifications) {
        if (now - seenAt > DEDUPE_WINDOW_MS) recentNotifications.delete(existingKey)
    }

    while (recentNotifications.size > MAX_RECENT_NOTIFICATIONS) {
        const oldest = recentNotifications.keys().next().value as string | undefined
        if (!oldest) break
        recentNotifications.delete(oldest)
    }

    return previous !== undefined && now - previous < DEDUPE_WINDOW_MS
}

function buildEmbed(
    content: string,
    level: LogLevel,
    parsed: ParsedLog | null,
    settings: ResolvedDiscordSettings
): DiscordEmbed {
    if (!parsed) {
        return {
            title: level === 'error' ? '❌ Rewards Error' : level === 'warn' ? '⚠️ Rewards Warning' : 'ℹ️ Rewards Update',
            description: truncate(sanitizeText(content, settings.maskAccount)),
            url: settings.dashboardUrl,
            color: LEVEL_COLOR[level] ?? LEVEL_COLOR.info
        }
    }

    const fields: DiscordField[] = []
    const cleanMessage = sanitizeText(parsed.message, settings.maskAccount)
    let title = humanizeEvent(parsed.event)
    let color = LEVEL_COLOR[parsed.level] ?? LEVEL_COLOR.info
    let description = cleanMessage

    if (parsed.account !== 'MAIN') addField(fields, 'Account', displayAccount(parsed.account, settings.maskAccount))
    if (parsed.platform !== 'MAIN') addField(fields, 'Platform', parsed.platform === 'MOBILE' ? '📱 Mobile' : '🖥️ Desktop')

    switch (parsed.event) {
        case 'RUN-START': {
            title = '🚀 Rewards Run Started'
            addField(fields, 'Version', cleanMessage.match(/\|\s*(v\d+(?:\.\d+)*)\s*\|/)?.[1])
            addField(fields, 'Accounts', colonMetric(cleanMessage, 'Accounts'))
            addField(fields, 'Clusters', colonMetric(cleanMessage, 'Clusters'))
            description = 'Microsoft Rewards automation has started.'
            break
        }
        case 'ACCOUNT-START': {
            title = '👤 Account Started'
            addField(fields, 'Locale', colonMetric(cleanMessage, 'locale'))
            addField(fields, 'Geo', colonMetric(cleanMessage, 'geoLocale'))
            description = 'Processing this Microsoft Rewards account.'
            break
        }
        case 'POINTS': {
            title = '💰 Points Available Today'
            color = POINTS_COLOR
            addField(fields, 'Mobile', colonMetric(cleanMessage, 'Mobile'))
            addField(fields, 'Browser', colonMetric(cleanMessage, 'Browser'))
            addField(fields, 'App', colonMetric(cleanMessage, 'App'))
            description = 'Daily earning opportunities detected.'
            break
        }
        case 'DAILY-SET': {
            title = '✅ Daily Set Complete'
            color = SUCCESS_COLOR
            description = cleanMessage
            break
        }
        case 'MORE-PROMOTIONS': {
            title = '✅ More Promotions Complete'
            color = SUCCESS_COLOR
            description = 'Finished processing available More Promotions activities.'
            break
        }
        case 'DAILY-CHECK-IN': {
            if (cleanMessage.startsWith('Completed')) {
                title = '📅 Daily Check-In Complete'
                color = SUCCESS_COLOR
                addField(fields, 'Points earned', metric(cleanMessage, 'pointsGained'))
                addField(fields, 'Current balance', metric(cleanMessage, 'currentBalance'))
                description = 'Daily app check-in completed.'
            }
            break
        }
        case 'APP-PROMOTIONS': {
            title = '📱 App Promotions Complete'
            color = SUCCESS_COLOR
            description = 'Finished processing available app promotions.'
            break
        }
        case 'READ-TO-EARN': {
            if (cleanMessage.startsWith('Completed')) {
                title = '📰 Read to Earn Complete'
                color = SUCCESS_COLOR
                addField(fields, 'Articles read', metric(cleanMessage, 'articlesRead'))
                addField(fields, 'Points earned', metric(cleanMessage, 'pointsGained'))
                addField(fields, 'Previous balance', metric(cleanMessage, 'previousBalance'))
                addField(fields, 'Current balance', metric(cleanMessage, 'currentBalance'))
                description = 'Read to Earn finished successfully.'
            }
            break
        }
        case 'PUNCHCARD': {
            const quest = cleanMessage.match(/Quest "([^"]+)"/)?.[1]
            if (/\bCOMPLETE\b/.test(cleanMessage)) {
                title = '🎯 Punchcard Complete'
                color = SUCCESS_COLOR
                addField(fields, 'Quest', quest, false)
                addField(fields, 'Points earned', metric(cleanMessage, 'pointsGained'))
                addField(fields, 'Current balance', metric(cleanMessage, 'currentBalance'))
                addField(fields, 'Target points', metric(cleanMessage, 'targetPoints'))
                description = 'A Rewards quest/punchcard was completed.'
            }
            break
        }
        case 'SEARCH-MANAGER': {
            if (cleanMessage.startsWith('Search summary')) {
                title = '🔎 Search Summary'
                color = SEARCH_COLOR
                addField(fields, 'Mobile', metric(cleanMessage, 'mobile'))
                addField(fields, 'Desktop', metric(cleanMessage, 'desktop'))
                addField(fields, 'Bonus', metric(cleanMessage, 'bonus'))
                addField(fields, 'Total', metric(cleanMessage, 'total'))
                description = 'Search earning phase finished.'
            }
            break
        }
        case 'CLAIM-BONUS-POINTS': {
            if (cleanMessage.startsWith('Completed')) {
                title = '🎁 Bonus Points Claimed'
                color = SUCCESS_COLOR
                addField(fields, 'Points earned', metric(cleanMessage, 'pointsGained'))
                addField(fields, 'Current balance', metric(cleanMessage, 'currentBalance'))
                description = 'Available bonus points were claimed.'
            }
            break
        }
        case 'FLOW': {
            if (cleanMessage.startsWith('Points collected')) {
                title = '📊 Account Earnings Summary'
                color = ACTIVITY_COLOR
                addField(fields, 'Points earned', metric(cleanMessage, 'pointsGained'))
                addField(fields, 'Current balance', metric(cleanMessage, 'currentBalance'))
                description = 'All earning activities for this account are complete.'
            }
            break
        }
        case 'ACCOUNT-END': {
            title = '✅ Account Complete'
            color = SUCCESS_COLOR
            addField(fields, 'Points earned', metric(cleanMessage, 'pointsGained'))
            addField(fields, 'Previous balance', metric(cleanMessage, 'previousBalance'))
            addField(fields, 'Current balance', metric(cleanMessage, 'currentBalance'))
            const duration = metric(cleanMessage, 'durationSeconds')
            addField(fields, 'Duration', duration ? `${duration}s` : undefined)
            description = 'Account processing finished successfully.'
            break
        }
        case 'RUN-END': {
            title = '🏁 Rewards Run Complete'
            color = SUCCESS_COLOR
            addField(fields, 'Accounts processed', metric(cleanMessage, 'accountsProcessed'))
            addField(fields, 'Points earned', metric(cleanMessage, 'pointsGained'))
            addField(fields, 'Previous balance', metric(cleanMessage, 'previousBalance'))
            addField(fields, 'Current balance', metric(cleanMessage, 'currentBalance'))
            const runtime = metric(cleanMessage, 'runtimeMinutes')
            addField(fields, 'Runtime', runtime ? `${runtime} min` : undefined)
            description = 'All configured accounts finished successfully.'
            break
        }
        case 'SEARCH-ON-BING-SEARCH': {
            if (cleanMessage.includes('Skipping incompatible SearchOnBing offer')) {
                title = '⏭️ Explore on Bing Offer Skipped'
                color = LEVEL_COLOR.warn
                addField(fields, 'Offer', metric(cleanMessage, 'title') ?? metric(cleanMessage, 'offerId'), false)
                description = 'Bing did not expose a compatible interactive search box, so this offer was skipped safely.'
            }
            break
        }
        default: {
            if (parsed.level === 'error') title = `❌ ${title}`
            else if (parsed.level === 'warn') title = `⚠️ ${title}`
            else title = `ℹ️ ${title}`
        }
    }

    if (parsed.level === 'error') {
        color = LEVEL_COLOR.error
        description = `**Error:** ${cleanMessage}`
    }

    return {
        title: truncate(title, 256),
        description: truncate(description),
        url: settings.dashboardUrl,
        color,
        fields: fields.length ? fields.slice(0, 25) : undefined,
        footer: { text: `Microsoft Rewards Script • ${parsed.platform} • ${settings.mode}` },
        timestamp: toIsoTimestamp(parsed.timestamp)
    }
}

function retryDelayMs(error: unknown, attempt: number): number {
    const response = (error as { response?: HttpResponse<unknown> })?.response
    const data = response?.data as { retry_after?: number } | undefined
    const retryAfterBody = Number(data?.retry_after)
    if (Number.isFinite(retryAfterBody) && retryAfterBody > 0) {
        return retryAfterBody > 1000 ? retryAfterBody : retryAfterBody * 1000
    }

    const retryHeader = response?.headers?.['retry-after']
    const retryHeaderValue = Array.isArray(retryHeader) ? retryHeader[0] : retryHeader
    const retryAfterHeader = Number(retryHeaderValue)
    if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) {
        return retryAfterHeader > 1000 ? retryAfterHeader : retryAfterHeader * 1000
    }

    return Math.min(1000 * 2 ** attempt, 8000)
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function postWithRetry(request: HttpRequestConfig): Promise<void> {
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
        try {
            await httpRequest(request)
            return
        } catch (error) {
            const response = (error as { response?: HttpResponse<unknown>; status?: number })?.response
            const status = response?.status ?? (error as { status?: number })?.status
            const retriable = status === 429 || (status !== undefined && status >= 500 && status <= 599)

            if (!retriable || attempt >= MAX_SEND_ATTEMPTS - 1) return
            await sleep(retryDelayMs(error, attempt))
        }
    }
}

export async function sendDiscord(
    config: WebhookDiscordConfig,
    content: string,
    level: LogLevel,
    webhookAllowed = true
): Promise<void> {
    if (!config.url) return

    const settings = resolveSettings(config)
    const parsed = parseLog(content, level)
    if (!shouldSend(parsed, level, settings, webhookAllowed)) return

    const notificationKey = makeNotificationKey(parsed, content, level)
    if (isDuplicate(notificationKey)) return

    const data: Record<string, unknown> = {
        username: settings.username,
        embeds: [buildEmbed(content, level, parsed, settings)],
        allowed_mentions: { parse: [] }
    }
    if (settings.avatarUrl) data.avatar_url = settings.avatarUrl

    const request: HttpRequestConfig = {
        method: 'POST',
        url: config.url,
        headers: { 'Content-Type': 'application/json' },
        data,
        timeout: 10000
    }

    await discordQueue.add(() => postWithRetry(request))
}

export function flushDiscordQueue(timeoutMs = 5000): Promise<void> {
    return flushQueue(discordQueue, timeoutMs)
}
