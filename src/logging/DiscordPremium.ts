import { httpRequest } from '../util/Http'
import type { HttpRequestConfig, HttpResponse } from '../util/Http'
import PQueue from 'p-queue'
import type { DiscordNotificationMode, WebhookDiscordConfig } from '../interface/Config'
import type { LogLevel } from './Logger'
import { flushQueue } from './Queue'

const EMBED_DESCRIPTION_LIMIT = 3900
const EMBED_FIELD_LIMIT = 1000
const EMBED_TOTAL_LIMIT = 5900
const DEDUPE_WINDOW_MS = 30_000
const TRACK_DEDUPE_WINDOW_MS = 5_000
const MAX_RECENT_NOTIFICATIONS = 100
const MAX_RECENT_TRACKED = 250
const MAX_SEND_ATTEMPTS = 3
const MAX_RETRY_DELAY_MS = 15_000

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
    footer?: { text: string; icon_url?: string }
    timestamp?: string
    author?: { name: string; url?: string; icon_url?: string }
    thumbnail?: { url: string }
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

interface RunTotals {
    urlActivities: number
    appRewards: number
    readToEarn: number
    punchcards: number
    checkIn: number
    bonus: number
    search: number
    skippedOffers: number
    significantWarnings: number
    errors: number
    accountsCompleted: number
    version?: string
}

const COLORS = {
    success: 0x57f287,
    info: 0x5865f2,
    warning: 0xfee75c,
    error: 0xed4245,
    points: 0xf1c40f,
    search: 0x3498db,
    activity: 0x9b59b6
} as const

const discordQueue = new PQueue({
    concurrency: 1,
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

const recentNotifications = new Map<string, number>()
const recentTrackedEvents = new Map<string, number>()
const skippedOfferIds = new Set<string>()

function emptyRunTotals(): RunTotals {
    return {
        urlActivities: 0,
        appRewards: 0,
        readToEarn: 0,
        punchcards: 0,
        checkIn: 0,
        bonus: 0,
        search: 0,
        skippedOffers: 0,
        significantWarnings: 0,
        errors: 0,
        accountsCompleted: 0
    }
}

let runTotals = emptyRunTotals()

function truncate(text: string, limit = EMBED_DESCRIPTION_LIMIT): string {
    if (text.length <= limit) return text
    const suffix = ' …(truncated)'
    return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`
}

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

function maskIdentifier(value: string): string {
    if (!value) return 'Unknown'
    const at = value.indexOf('@')
    if (at > 0) {
        const local = value.slice(0, at)
        const domain = value.slice(at + 1)
        const visible = local.slice(0, Math.min(2, local.length))
        return `${visible}${local.length > visible.length ? '***' : ''}@${domain}`
    }
    if (value.length <= 2) return `${value[0] ?? '*'}*`
    return `${value.slice(0, 2)}***`
}

function displayAccount(account: string, shouldMask: boolean): string {
    if (!account || account === 'MAIN') return 'Main process'
    return shouldMask ? maskIdentifier(account) : account
}

function sanitizeText(text: string, maskAccounts = true): string {
    let out = text
        .replace(
            /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s)]+/gi,
            '[Discord webhook redacted]'
        )
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(
            /([?&](?:access_token|refresh_token|id_token|token|secret|code|assertion|session|auth)=)[^&#\s]+/gi,
            '$1[redacted]'
        )
        .replace(
            /((?:access_token|refresh_token|id_token|token|secret|assertion)\s*[=:]\s*)[^|,;\s]+/gi,
            '$1[redacted]'
        )

    if (maskAccounts) {
        out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, value => maskIdentifier(value))
    }

    return out
}

function metric(message: string, key: string): string | undefined {
    const prefix = `${key.toLowerCase()}=`
    for (const rawPart of message.split('|')) {
        const part = rawPart.trim()
        if (part.toLowerCase().startsWith(prefix)) return part.slice(prefix.length).trim()
    }
    return undefined
}

function colonMetric(message: string, key: string): string | undefined {
    const prefix = `${key.toLowerCase()}:`
    for (const rawPart of message.split('|')) {
        const part = rawPart.trim()
        if (part.toLowerCase().startsWith(prefix)) return part.slice(prefix.length).trim()
    }
    return undefined
}

function numberValue(value: string | undefined): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

function numberMetric(message: string, key: string): number {
    return numberValue(metric(message, key))
}

function numberColonMetric(message: string, key: string): number {
    return numberValue(colonMetric(message, key))
}

function formatPoints(value: number): string {
    return Math.round(value).toLocaleString('en-US')
}

function formatDurationSeconds(value: number): string {
    if (!Number.isFinite(value) || value < 0) return '—'
    const total = Math.round(value)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
}

function formatRuntimeMinutes(value: number): string {
    return formatDurationSeconds(value * 60)
}

function progressBar(value: number, total: number, width = 10): string {
    if (total <= 0) return '▱'.repeat(width)
    const ratio = Math.max(0, Math.min(1, value / total))
    const filled = Math.round(ratio * width)
    return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
}

function addField(fields: DiscordField[], name: string, value: string | undefined, inline = true): void {
    if (!value) return
    fields.push({ name: truncate(name, 256), value: truncate(value, EMBED_FIELD_LIMIT), inline })
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

function discordRequestUrl(value: string): string | undefined {
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
        url.searchParams.set('wait', 'true')
        return url.toString()
    } catch {
        return undefined
    }
}

function toIsoTimestamp(value: string): string | undefined {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return fallback
    if (raw.toLowerCase() === 'true') return true
    if (raw.toLowerCase() === 'false') return false
    return fallback
}

function resolveMode(value: string | undefined, fallback: DiscordNotificationMode): DiscordNotificationMode {
    const normalized = value?.toLowerCase()
    return normalized === 'summary' || normalized === 'standard' || normalized === 'verbose' ? normalized : fallback
}

function resolveSettings(config: WebhookDiscordConfig): ResolvedDiscordSettings {
    return {
        mode: resolveMode(process.env.CONFIG_DISCORD_MODE, config.mode ?? 'standard'),
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

function cleanupMap(map: Map<string, number>, windowMs: number, maxEntries: number): void {
    const now = Date.now()
    for (const [key, seenAt] of map) {
        if (now - seenAt > windowMs) map.delete(key)
    }
    while (map.size > maxEntries) {
        const oldest = map.keys().next().value as string | undefined
        if (!oldest) break
        map.delete(oldest)
    }
}

function shouldTrackEvent(parsed: ParsedLog): boolean {
    if (parsed.event === 'RUN-START') return true
    const key = `${parsed.level}|${parsed.event}|${parsed.message}`
    const now = Date.now()
    const previous = recentTrackedEvents.get(key)
    recentTrackedEvents.set(key, now)
    cleanupMap(recentTrackedEvents, TRACK_DEDUPE_WINDOW_MS, MAX_RECENT_TRACKED)
    return previous === undefined || now - previous >= TRACK_DEDUPE_WINDOW_MS
}

function isSignificantWarning(parsed: ParsedLog): boolean {
    const text = parsed.message.toLowerCase()
    if (parsed.event === 'SEARCH-ON-BING-SEARCH' && text.includes('skipping incompatible searchonbing offer'))
        return false
    if (parsed.event === 'SEARCH-ON-BING' && text.includes('failed searchonbing')) {
        const offerId = metric(parsed.message, 'offerId')
        if (offerId && skippedOfferIds.has(offerId)) return false
    }
    if (parsed.event === 'BROWSER' && text.includes('browser context closed')) return false
    return (
        text.includes('out of memory') ||
        text.includes('memory limit') ||
        text.includes('timeout') ||
        text.includes('failed') ||
        text.includes('unknown state') ||
        text.includes('unavailable')
    )
}

function trackRun(parsed: ParsedLog | null, fallbackLevel: LogLevel): void {
    if (!parsed || !shouldTrackEvent(parsed)) return

    if (parsed.event === 'RUN-START') {
        runTotals = emptyRunTotals()
        runTotals.version = parsed.message.match(/\|\s*(v\d+(?:\.\d+)*)\s*\|/)?.[1]
        skippedOfferIds.clear()
        recentTrackedEvents.clear()
        return
    }

    if (parsed.level === 'error' || fallbackLevel === 'error') runTotals.errors += 1
    if (parsed.level === 'warn' && isSignificantWarning(parsed)) runTotals.significantWarnings += 1

    switch (parsed.event) {
        case 'URL-REWARD':
            if (parsed.message.startsWith('Completed'))
                runTotals.urlActivities += numberMetric(parsed.message, 'pointsGained')
            break
        case 'APP-REWARD':
            if (parsed.message.startsWith('Completed'))
                runTotals.appRewards += numberMetric(parsed.message, 'pointsGained')
            break
        case 'READ-TO-EARN':
            if (parsed.message.startsWith('Completed'))
                runTotals.readToEarn += numberMetric(parsed.message, 'pointsGained')
            break
        case 'PUNCHCARD':
            if (/\bCOMPLETE\b/.test(parsed.message))
                runTotals.punchcards += numberMetric(parsed.message, 'pointsGained')
            break
        case 'DAILY-CHECK-IN':
            if (parsed.message.startsWith('Completed'))
                runTotals.checkIn += numberMetric(parsed.message, 'pointsGained')
            break
        case 'CLAIM-BONUS-POINTS':
            if (parsed.message.startsWith('Completed')) runTotals.bonus += numberMetric(parsed.message, 'pointsGained')
            break
        case 'SEARCH-MANAGER':
            if (parsed.message.startsWith('Search summary')) runTotals.search = numberMetric(parsed.message, 'total')
            break
        case 'SEARCH-ON-BING-SEARCH':
            if (parsed.message.includes('Skipping incompatible SearchOnBing offer')) {
                runTotals.skippedOffers += 1
                const offerId = metric(parsed.message, 'offerId')
                if (offerId) skippedOfferIds.add(offerId)
            }
            break
        case 'ACCOUNT-END':
            runTotals.accountsCompleted += 1
            break
        default:
            break
    }
}

function earningRows(totalPoints: number): string {
    const categories = [
        ['🔗', 'URL activities', runTotals.urlActivities],
        ['📱', 'App rewards', runTotals.appRewards],
        ['📰', 'Read to Earn', runTotals.readToEarn],
        ['🎯', 'Punchcards', runTotals.punchcards],
        ['📅', 'Daily check-in', runTotals.checkIn],
        ['🎁', 'Bonus claims', runTotals.bonus],
        ['🔎', 'Search', runTotals.search]
    ] as const

    const known = categories.reduce((sum, [, , value]) => sum + value, 0)
    const other = Math.max(0, totalPoints - known)
    const rows: string[] = []

    for (const [emoji, name, value] of categories) {
        if (value <= 0) continue
        rows.push(`${emoji} **${name}**  ${progressBar(value, totalPoints, 8)}  **+${formatPoints(value)}**`)
    }
    if (other > 0) rows.push(`✨ **Other**  ${progressBar(other, totalPoints, 8)}  **+${formatPoints(other)}**`)

    return rows.length > 0 ? rows.join('\n') : 'No points were earned during this run.'
}

function dashboardField(settings: ResolvedDiscordSettings): string | undefined {
    return settings.dashboardUrl ? `[Open Rewards Dashboard](${settings.dashboardUrl})` : undefined
}

function baseAuthor(settings: ResolvedDiscordSettings): DiscordEmbed['author'] {
    const author: NonNullable<DiscordEmbed['author']> = { name: 'Microsoft Rewards Automation' }
    if (settings.dashboardUrl) author.url = settings.dashboardUrl
    if (settings.avatarUrl) author.icon_url = settings.avatarUrl
    return author
}

function footer(settings: ResolvedDiscordSettings, parsed: ParsedLog): DiscordEmbed['footer'] {
    const out: NonNullable<DiscordEmbed['footer']> = {
        text: `Rewards Script • ${parsed.platform} • ${settings.mode.toUpperCase()}`
    }
    if (settings.avatarUrl) out.icon_url = settings.avatarUrl
    return out
}

function embedCharCount(embed: DiscordEmbed): number {
    let total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0)
    total += embed.footer?.text.length ?? 0
    total += embed.author?.name.length ?? 0
    for (const field of embed.fields ?? []) total += field.name.length + field.value.length
    return total
}

function fitEmbedToDiscordLimits(embed: DiscordEmbed): DiscordEmbed {
    const fitted: DiscordEmbed = {
        ...embed,
        title: truncate(embed.title, 256),
        description: embed.description ? truncate(embed.description, 4096) : undefined,
        author: embed.author ? { ...embed.author, name: truncate(embed.author.name, 256) } : undefined,
        footer: embed.footer ? { ...embed.footer, text: truncate(embed.footer.text, 2048) } : undefined,
        fields: embed.fields?.slice(0, 25).map(field => ({
            ...field,
            name: truncate(field.name, 256),
            value: truncate(field.value, 1024)
        }))
    }

    while (embedCharCount(fitted) > EMBED_TOTAL_LIMIT) {
        const fields = fitted.fields ?? []
        let longestIndex = -1
        let longestLength = 0
        for (let i = 0; i < fields.length; i++) {
            const length = fields[i]?.value.length ?? 0
            if (length > longestLength) {
                longestLength = length
                longestIndex = i
            }
        }

        if (longestIndex >= 0 && longestLength > 160) {
            const field = fields[longestIndex]
            if (field) field.value = truncate(field.value, Math.max(160, field.value.length - 300))
            continue
        }
        if (fitted.description && fitted.description.length > 500) {
            fitted.description = truncate(fitted.description, Math.max(500, fitted.description.length - 300))
            continue
        }
        if (fields.length > 0) {
            fields.pop()
            continue
        }
        break
    }

    return fitted
}

function commonEmbed(
    settings: ResolvedDiscordSettings,
    parsed: ParsedLog,
    title: string,
    description: string,
    color: number,
    fields: DiscordField[]
): DiscordEmbed {
    const embed: DiscordEmbed = {
        title,
        description,
        color,
        fields: fields.length > 0 ? fields : undefined,
        footer: footer(settings, parsed),
        author: baseAuthor(settings),
        timestamp: toIsoTimestamp(parsed.timestamp)
    }
    if (settings.dashboardUrl) embed.url = settings.dashboardUrl
    if (settings.avatarUrl) embed.thumbnail = { url: settings.avatarUrl }
    return fitEmbedToDiscordLimits(embed)
}

function humanizeEvent(event: string): string {
    return event
        .replace(/[-_]+/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, char => char.toUpperCase())
}

function buildPremiumEmbed(
    content: string,
    level: LogLevel,
    parsed: ParsedLog | null,
    settings: ResolvedDiscordSettings
): DiscordEmbed {
    if (!parsed) {
        const embed: DiscordEmbed = {
            title:
                level === 'error' ? '🚨 Rewards Error' : level === 'warn' ? '⚠️ Rewards Warning' : 'ℹ️ Rewards Update',
            description: sanitizeText(content, settings.maskAccount),
            color: level === 'error' ? COLORS.error : level === 'warn' ? COLORS.warning : COLORS.info,
            author: baseAuthor(settings)
        }
        if (settings.dashboardUrl) embed.url = settings.dashboardUrl
        if (settings.avatarUrl) embed.thumbnail = { url: settings.avatarUrl }
        return fitEmbedToDiscordLimits(embed)
    }

    const fields: DiscordField[] = []
    const cleanMessage = sanitizeText(parsed.message, settings.maskAccount)
    const account = displayAccount(parsed.account, settings.maskAccount)

    if (parsed.account !== 'MAIN') addField(fields, '👤 Account', account)
    if (parsed.platform !== 'MAIN')
        addField(fields, '🖥️ Platform', parsed.platform === 'MOBILE' ? '📱 Mobile' : '🖥️ Desktop')

    if (parsed.level === 'error') {
        addField(fields, '🛡️ Run health', '🔴 **Error detected**\nThis event needs attention.', false)
        addField(fields, '🔗 Dashboard', dashboardField(settings), false)
        return commonEmbed(
            settings,
            parsed,
            `🚨 ${humanizeEvent(parsed.event)} Error`,
            `**What happened**\n${truncate(cleanMessage, 1800)}`,
            COLORS.error,
            fields
        )
    }

    switch (parsed.event) {
        case 'RUN-START': {
            const version = cleanMessage.match(/\|\s*(v\d+(?:\.\d+)*)\s*\|/)?.[1] ?? runTotals.version
            addField(fields, '📦 Version', version)
            addField(fields, '👥 Accounts', colonMetric(cleanMessage, 'Accounts'))
            addField(fields, '⚙️ Clusters', colonMetric(cleanMessage, 'Clusters'))
            addField(fields, '🔔 Notification mode', settings.mode.toUpperCase())
            addField(fields, '🛡️ Status', '🔵 **Initializing**\n`▰▱▱▱▱▱▱▱▱▱`', false)
            addField(fields, '🔗 Dashboard', dashboardField(settings), false)
            return commonEmbed(
                settings,
                parsed,
                '🚀 Microsoft Rewards • Run Started',
                'A new automated Rewards run is starting. Meaningful milestones and the final earnings summary will be reported here.',
                COLORS.info,
                fields
            )
        }
        case 'ACCOUNT-START': {
            addField(fields, '🌎 Geo', colonMetric(cleanMessage, 'geoLocale'))
            addField(fields, '🗣️ Locale', colonMetric(cleanMessage, 'locale'))
            addField(fields, '⏳ Progress', '`▰▰▱▱▱▱▱▱▱▱`  Starting account', false)
            return commonEmbed(
                settings,
                parsed,
                '👤 Account Processing Started',
                'Authentication and Rewards context setup are beginning for this account.',
                COLORS.info,
                fields
            )
        }
        case 'POINTS': {
            const mobile = numberColonMetric(cleanMessage, 'Mobile')
            const browser = numberColonMetric(cleanMessage, 'Browser')
            const app = numberColonMetric(cleanMessage, 'App')
            const total = mobile + browser + app
            addField(fields, '📱 Mobile', `**${formatPoints(mobile)} pts**\n${progressBar(mobile, total, 7)}`)
            addField(fields, '🖥️ Browser', `**${formatPoints(browser)} pts**\n${progressBar(browser, total, 7)}`)
            addField(fields, '📲 App', `**${formatPoints(app)} pts**\n${progressBar(app, total, 7)}`)
            addField(
                fields,
                '💎 Detected potential',
                `**${formatPoints(total)} points** across the reported search/app earning buckets.`,
                false
            )
            return commonEmbed(
                settings,
                parsed,
                `💰 Today's Earning Potential • ${formatPoints(total)} pts`,
                'Rewards earning potential detected at the start of this account run.',
                COLORS.points,
                fields
            )
        }
        case 'DAILY-SET': {
            addField(fields, '✅ Status', 'Complete')
            addField(fields, '📍 Stage', 'Daily Set')
            return commonEmbed(
                settings,
                parsed,
                '✅ Daily Set Complete',
                'The Daily Set stage is finished.',
                COLORS.success,
                fields
            )
        }
        case 'MORE-PROMOTIONS': {
            addField(fields, '✅ Status', 'Complete')
            addField(fields, '📍 Stage', 'More Promotions')
            return commonEmbed(
                settings,
                parsed,
                '✨ More Promotions Complete',
                'Available More Promotions activities have been processed.',
                COLORS.success,
                fields
            )
        }
        case 'DAILY-CHECK-IN': {
            const gained = numberMetric(cleanMessage, 'pointsGained')
            const balance = numberMetric(cleanMessage, 'currentBalance')
            addField(fields, '💎 Earned', `**+${formatPoints(gained)} pts**`)
            addField(fields, '🏦 Balance', `**${formatPoints(balance)} pts**`)
            return commonEmbed(
                settings,
                parsed,
                `📅 Daily Check-In • +${formatPoints(gained)} pts`,
                'Daily check-in completed successfully.',
                COLORS.success,
                fields
            )
        }
        case 'APP-PROMOTIONS': {
            addField(fields, '✅ Status', 'Complete')
            addField(fields, '📍 Stage', 'App Promotions')
            return commonEmbed(
                settings,
                parsed,
                '📱 App Promotions Complete',
                'Available app promotion activities have been processed.',
                COLORS.success,
                fields
            )
        }
        case 'READ-TO-EARN': {
            const gained = numberMetric(cleanMessage, 'pointsGained')
            const articles = numberMetric(cleanMessage, 'articlesRead')
            const balance = numberMetric(cleanMessage, 'currentBalance')
            addField(fields, '📰 Articles', `**${Math.round(articles)}**`)
            addField(fields, '💎 Earned', `**+${formatPoints(gained)} pts**`)
            addField(fields, '🏦 Balance', `**${formatPoints(balance)} pts**`)
            addField(fields, '📈 Completion', `${progressBar(articles, Math.max(articles, 1), 10)}  **100%**`, false)
            return commonEmbed(
                settings,
                parsed,
                `📰 Read to Earn Complete • +${formatPoints(gained)} pts`,
                'All reported Read to Earn articles were processed successfully.',
                COLORS.success,
                fields
            )
        }
        case 'PUNCHCARD': {
            const gained = numberMetric(cleanMessage, 'pointsGained')
            const balance = numberMetric(cleanMessage, 'currentBalance')
            const target = numberMetric(cleanMessage, 'targetPoints')
            const quest = cleanMessage.match(/Quest "([^"]+)"/)?.[1]
            addField(fields, '🎯 Quest', quest, false)
            addField(fields, '💎 Earned', `**+${formatPoints(gained)} pts**`)
            addField(fields, '🏦 Balance', `**${formatPoints(balance)} pts**`)
            if (target > 0) addField(fields, '🏁 Target', `${formatPoints(target)} pts`)
            return commonEmbed(
                settings,
                parsed,
                `🎯 Punchcard Complete${gained > 0 ? ` • +${formatPoints(gained)} pts` : ''}`,
                'A Rewards quest/punchcard reached its completed state.',
                COLORS.success,
                fields
            )
        }
        case 'SEARCH-MANAGER': {
            const mobile = numberMetric(cleanMessage, 'mobile')
            const desktop = numberMetric(cleanMessage, 'desktop')
            const bonus = numberMetric(cleanMessage, 'bonus')
            const total = numberMetric(cleanMessage, 'total')
            addField(fields, '📱 Mobile', `**+${formatPoints(mobile)}**`)
            addField(fields, '🖥️ Desktop', `**+${formatPoints(desktop)}**`)
            addField(fields, '✨ Bonus', `**+${formatPoints(bonus)}**`)
            addField(
                fields,
                '🔎 Search total',
                `**+${formatPoints(total)} points**\n${progressBar(total, Math.max(total, 1), 10)}`,
                false
            )
            return commonEmbed(
                settings,
                parsed,
                `🔎 Search Phase Complete • +${formatPoints(total)} pts`,
                'Search earning is complete for this account.',
                COLORS.search,
                fields
            )
        }
        case 'CLAIM-BONUS-POINTS': {
            const gained = numberMetric(cleanMessage, 'pointsGained')
            const balance = numberMetric(cleanMessage, 'currentBalance')
            addField(fields, '🎁 Claimed', `**+${formatPoints(gained)} pts**`)
            addField(fields, '🏦 Balance', `**${formatPoints(balance)} pts**`)
            return commonEmbed(
                settings,
                parsed,
                `🎁 Bonus Claimed • +${formatPoints(gained)} pts`,
                'Available bonus points were claimed successfully.',
                COLORS.success,
                fields
            )
        }
        case 'FLOW': {
            const gained = numberMetric(cleanMessage, 'pointsGained')
            const balance = numberMetric(cleanMessage, 'currentBalance')
            addField(fields, '💎 Account earnings', `**+${formatPoints(gained)} pts**`)
            addField(fields, '🏦 Current balance', `**${formatPoints(balance)} pts**`)
            return commonEmbed(
                settings,
                parsed,
                `📊 Account Earnings • +${formatPoints(gained)} pts`,
                'Foreground earning activities for this account are complete.',
                COLORS.activity,
                fields
            )
        }
        case 'ACCOUNT-END': {
            const gained = numberMetric(cleanMessage, 'pointsGained')
            const previous = numberMetric(cleanMessage, 'previousBalance')
            const current = numberMetric(cleanMessage, 'currentBalance')
            const duration = numberMetric(cleanMessage, 'durationSeconds')
            const rate = duration > 0 ? gained / (duration / 60) : 0
            addField(
                fields,
                '💎 Earned',
                `**+${formatPoints(gained)} pts**\n${progressBar(gained, Math.max(gained, 1), 8)}`
            )
            addField(fields, '🏦 Balance', `${formatPoints(previous)} → **${formatPoints(current)}**`)
            addField(fields, '⏱️ Runtime', `**${formatDurationSeconds(duration)}**`)
            if (rate > 0) addField(fields, '⚡ Efficiency', `**${rate.toFixed(1)} pts/min**`)
            addField(fields, '✅ Result', '**SUCCESS**\nAccount completed cleanly.', false)
            return commonEmbed(
                settings,
                parsed,
                `✅ Account Complete • +${formatPoints(gained)} pts`,
                'This account finished successfully and its final balance was recorded.',
                COLORS.success,
                fields
            )
        }
        case 'RUN-END': {
            const accounts = numberMetric(cleanMessage, 'accountsProcessed')
            const gained = numberMetric(cleanMessage, 'pointsGained')
            const previous = numberMetric(cleanMessage, 'previousBalance')
            const current = numberMetric(cleanMessage, 'currentBalance')
            const runtimeMinutes = numberMetric(cleanMessage, 'runtimeMinutes')
            const rate = runtimeMinutes > 0 ? gained / runtimeMinutes : 0
            const healthy = runTotals.errors === 0 && runTotals.significantWarnings === 0

            addField(fields, '💎 Total earned', `**+${formatPoints(gained)} pts**`)
            addField(fields, '🏦 Balance', `${formatPoints(previous)} → **${formatPoints(current)}**`)
            addField(fields, '⏱️ Runtime', `**${formatRuntimeMinutes(runtimeMinutes)}**`)
            addField(
                fields,
                '👥 Accounts',
                `**${Math.round(accounts)} processed**\n${runTotals.accountsCompleted} completed`
            )
            if (rate > 0) addField(fields, '⚡ Efficiency', `**${rate.toFixed(1)} pts/min**`)
            addField(fields, '📊 Earnings breakdown', earningRows(gained), false)
            addField(
                fields,
                '🛡️ Run health',
                healthy
                    ? `🟢 **HEALTHY**\n${runTotals.errors} errors • ${runTotals.significantWarnings} significant warnings\n${runTotals.skippedOffers} incompatible offers skipped safely`
                    : `🟠 **COMPLETED WITH ISSUES**\n${runTotals.errors} errors • ${runTotals.significantWarnings} significant warnings\n${runTotals.skippedOffers} incompatible offers skipped safely`,
                false
            )
            addField(fields, '🔗 Rewards Dashboard', dashboardField(settings), false)

            return commonEmbed(
                settings,
                parsed,
                healthy
                    ? `🏆 Rewards Run Complete • +${formatPoints(gained)} pts`
                    : `⚠️ Rewards Run Complete with Issues • +${formatPoints(gained)} pts`,
                healthy
                    ? '**SUCCESS** — All configured accounts finished and the run closed cleanly.'
                    : '**COMPLETED** — The run reached the end, but some noteworthy issues were observed.',
                healthy ? COLORS.success : COLORS.warning,
                fields
            )
        }
        case 'SEARCH-ON-BING-SEARCH': {
            if (cleanMessage.includes('Skipping incompatible SearchOnBing offer')) {
                const offerId = metric(cleanMessage, 'offerId')
                const title = metric(cleanMessage, 'title')
                addField(fields, '🎫 Offer', title || offerId, false)
                if (offerId && title) addField(fields, '🆔 Offer ID', offerId, false)
                addField(fields, '🛡️ Safety', 'Skipped without fabricating completion or offer progress.', false)
                return commonEmbed(
                    settings,
                    parsed,
                    '⏭️ Explore on Bing Offer Skipped Safely',
                    'Bing did not expose a compatible interactive search box, so the incompatible promotion was skipped.',
                    COLORS.warning,
                    fields
                )
            }
            break
        }
        default:
            break
    }

    const title = parsed.level === 'warn' ? `⚠️ ${humanizeEvent(parsed.event)}` : `ℹ️ ${humanizeEvent(parsed.event)}`
    return commonEmbed(
        settings,
        parsed,
        title,
        cleanMessage,
        parsed.level === 'warn' ? COLORS.warning : COLORS.info,
        fields
    )
}

const SUMMARY_EVENTS = new Set(['RUN-START', 'ACCOUNT-END', 'RUN-END'])

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
        default:
            return false
    }
}

function isImportantWarning(parsed: ParsedLog): boolean {
    return (
        (parsed.event === 'SEARCH-ON-BING-SEARCH' &&
            parsed.message.includes('Skipping incompatible SearchOnBing offer')) ||
        isSignificantWarning(parsed)
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
    cleanupMap(recentNotifications, DEDUPE_WINDOW_MS, MAX_RECENT_NOTIFICATIONS)
    return previous !== undefined && now - previous < DEDUPE_WINDOW_MS
}

function retryDelayMs(error: unknown, attempt: number): number {
    const response = (error as { response?: HttpResponse<unknown> })?.response
    const data = response?.data as { retry_after?: number } | undefined
    const retryAfterSeconds = Number(data?.retry_after)
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.ceil(retryAfterSeconds * 1000)

    const retryHeader = response?.headers?.['retry-after']
    const retryHeaderValue = Array.isArray(retryHeader) ? retryHeader[0] : retryHeader
    const retryHeaderSeconds = Number(retryHeaderValue)
    if (Number.isFinite(retryHeaderSeconds) && retryHeaderSeconds > 0) return Math.ceil(retryHeaderSeconds * 1000)

    const resetAfterHeader = response?.headers?.['x-ratelimit-reset-after']
    const resetAfterValue = Array.isArray(resetAfterHeader) ? resetAfterHeader[0] : resetAfterHeader
    const resetAfterSeconds = Number(resetAfterValue)
    if (Number.isFinite(resetAfterSeconds) && resetAfterSeconds > 0) return Math.ceil(resetAfterSeconds * 1000)

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
            const retriable = status === undefined || status === 429 || (status >= 500 && status <= 599)
            if (!retriable || attempt >= MAX_SEND_ATTEMPTS - 1) return
            const delay = retryDelayMs(error, attempt)
            if (delay > MAX_RETRY_DELAY_MS) return
            await sleep(delay)
        }
    }
}

export async function sendDiscordPremium(
    config: WebhookDiscordConfig,
    content: string,
    level: LogLevel,
    webhookAllowed = true
): Promise<void> {
    if (!config.url) return
    const requestUrl = discordRequestUrl(config.url)
    if (!requestUrl) return

    const settings = resolveSettings(config)
    const parsed = parseLog(content, level)
    trackRun(parsed, level)
    if (!shouldSend(parsed, level, settings, webhookAllowed)) return

    const notificationKey = makeNotificationKey(parsed, content, level)
    if (isDuplicate(notificationKey)) return

    const data: Record<string, unknown> = {
        username: settings.username,
        embeds: [buildPremiumEmbed(content, level, parsed, settings)],
        allowed_mentions: { parse: [] }
    }
    if (settings.avatarUrl) data.avatar_url = settings.avatarUrl

    const request: HttpRequestConfig = {
        method: 'POST',
        url: requestUrl,
        headers: { 'Content-Type': 'application/json' },
        data,
        timeout: 10000
    }

    await discordQueue.add(() => postWithRetry(request))
}

export function flushDiscordPremiumQueue(timeoutMs = 15_000): Promise<void> {
    return flushQueue(discordQueue, timeoutMs)
}
