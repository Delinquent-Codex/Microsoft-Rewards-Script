import { httpRequest } from '../util/Http'
import type { HttpRequestConfig } from '../util/Http'
import PQueue from 'p-queue'
import type { LogLevel } from './Logger'
import { flushQueue } from './Queue'

const EMBED_DESCRIPTION_LIMIT = 4000
const EMBED_FIELD_LIMIT = 1024

export interface DiscordConfig {
    enabled?: boolean
    url: string
}

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
    color: number
    fields?: DiscordField[]
    footer?: { text: string }
    timestamp?: string
}

const discordQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

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

const EVENT_TITLES: Record<string, string> = {
    'RUN-START': 'Rewards Run Started',
    'RUN-END': 'Rewards Run Complete',
    'ACCOUNT-START': 'Account Started',
    'ACCOUNT-END': 'Account Complete',
    POINTS: 'Points Available',
    FLOW: 'Rewards Progress',
    'CLAIM-BONUS-POINTS': 'Bonus Points',
    'LOGIN-BING': 'Bing Session',
    LOGIN: 'Microsoft Login'
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

function humanizeEvent(event: string): string {
    if (EVENT_TITLES[event]) return EVENT_TITLES[event]
    return event
        .replace(/[-_]+/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, char => char.toUpperCase())
}

function maskAccount(account: string): string {
    if (!account || account === 'MAIN') return 'Main process'
    const at = account.indexOf('@')
    if (at <= 0) return account

    const local = account.slice(0, at)
    const domain = account.slice(at + 1)
    const visible = local.slice(0, Math.min(2, local.length))
    return `${visible}${local.length > visible.length ? '***' : ''}@${domain}`
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

function buildEmbed(content: string, level: LogLevel): DiscordEmbed {
    const parsed = parseLog(content, level)
    if (!parsed) {
        return {
            title: level === 'error' ? '❌ Rewards Error' : level === 'warn' ? '⚠️ Rewards Warning' : 'ℹ️ Rewards Update',
            description: truncate(content),
            color: LEVEL_COLOR[level] ?? LEVEL_COLOR.info
        }
    }

    const fields: DiscordField[] = []
    let title = humanizeEvent(parsed.event)
    let color = LEVEL_COLOR[parsed.level] ?? LEVEL_COLOR.info
    let description = parsed.message

    addField(fields, 'Account', maskAccount(parsed.account))
    if (parsed.platform !== 'MAIN') addField(fields, 'Platform', parsed.platform === 'MOBILE' ? '📱 Mobile' : '🖥️ Desktop')

    switch (parsed.event) {
        case 'RUN-START': {
            title = '🚀 Rewards Run Started'
            addField(fields, 'Version', parsed.message.match(/\|\s*(v\d+(?:\.\d+)*)\s*\|/)?.[1])
            addField(fields, 'Accounts', colonMetric(parsed.message, 'Accounts'))
            addField(fields, 'Clusters', colonMetric(parsed.message, 'Clusters'))
            description = 'Microsoft Rewards automation has started.'
            break
        }
        case 'ACCOUNT-START': {
            title = '👤 Account Started'
            addField(fields, 'Locale', colonMetric(parsed.message, 'locale'))
            addField(fields, 'Geo', colonMetric(parsed.message, 'geoLocale'))
            description = 'Processing this Microsoft Rewards account.'
            break
        }
        case 'ACCOUNT-END': {
            title = '✅ Account Complete'
            color = SUCCESS_COLOR
            addField(fields, 'Points earned', metric(parsed.message, 'pointsGained'))
            addField(fields, 'Previous balance', metric(parsed.message, 'previousBalance'))
            addField(fields, 'Current balance', metric(parsed.message, 'currentBalance'))
            const duration = metric(parsed.message, 'durationSeconds')
            addField(fields, 'Duration', duration ? `${duration}s` : undefined)
            description = 'Account processing finished successfully.'
            break
        }
        case 'RUN-END': {
            title = '🏁 Rewards Run Complete'
            color = SUCCESS_COLOR
            addField(fields, 'Accounts processed', metric(parsed.message, 'accountsProcessed'))
            addField(fields, 'Points earned', metric(parsed.message, 'pointsGained'))
            addField(fields, 'Previous balance', metric(parsed.message, 'previousBalance'))
            addField(fields, 'Current balance', metric(parsed.message, 'currentBalance'))
            const runtime = metric(parsed.message, 'runtimeMinutes')
            addField(fields, 'Runtime', runtime ? `${runtime} min` : undefined)
            description = 'All configured accounts finished successfully.'
            break
        }
        case 'POINTS': {
            title = '💰 Points Available Today'
            color = POINTS_COLOR
            addField(fields, 'Mobile', colonMetric(parsed.message, 'Mobile'))
            addField(fields, 'Browser', colonMetric(parsed.message, 'Browser'))
            addField(fields, 'App', colonMetric(parsed.message, 'App'))
            description = 'Daily earning opportunities detected.'
            break
        }
        case 'CLAIM-BONUS-POINTS': {
            if (parsed.message.startsWith('Completed')) {
                title = '🎁 Bonus Points Claimed'
                color = SUCCESS_COLOR
                addField(fields, 'Points earned', metric(parsed.message, 'pointsGained'))
                addField(fields, 'Current balance', metric(parsed.message, 'currentBalance'))
                description = 'Available bonus points were claimed.'
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
        description = `**Error:** ${parsed.message}`
    }

    return {
        title: truncate(title, 256),
        description: truncate(description),
        color,
        fields: fields.length ? fields.slice(0, 25) : undefined,
        footer: { text: `Microsoft Rewards Script • ${parsed.platform}` },
        timestamp: toIsoTimestamp(parsed.timestamp)
    }
}

export async function sendDiscord(discordUrl: string, content: string, level: LogLevel): Promise<void> {
    if (!discordUrl) return

    const request: HttpRequestConfig = {
        method: 'POST',
        url: discordUrl,
        headers: { 'Content-Type': 'application/json' },
        data: {
            username: 'Microsoft Rewards',
            embeds: [buildEmbed(content, level)],
            allowed_mentions: { parse: [] }
        },
        timeout: 10000
    }

    await discordQueue.add(async () => {
        try {
            await httpRequest(request)
        } catch (err) {
            const status = (err as { response?: { status?: number } })?.response?.status
            if (status === 429) return
        }
    })
}

export function flushDiscordQueue(timeoutMs = 5000): Promise<void> {
    return flushQueue(discordQueue, timeoutMs)
}
