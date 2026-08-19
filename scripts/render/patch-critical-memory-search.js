async function main() {
    const fs = await import('node:fs')

    const target = 'src/functions/activities/search/BrowserSearch.ts'
    let source = fs.readFileSync(target, 'utf8')

    if (source.includes('Skipping post-search Bing navigation so browser cleanup can run immediately')) {
        console.log('[render-patch] Critical-memory Bing cleanup already applied')
        return
    }

    const replaceOnce = (oldText, newText, label) => {
        const count = source.split(oldText).length - 1
        if (count !== 1) {
            throw new Error(`${label}: expected exactly one patch target, found ${count}`)
        }
        source = source.replace(oldText, newText)
    }

    replaceOnce(
        'const CONTAINER_ABORT_THRESHOLD_PERCENT = 90',
        'const CONTAINER_ABORT_THRESHOLD_PERCENT = 82',
        'abort threshold'
    )

    replaceOnce(
        'export class Search extends BaseActivity {\n    private searchCount = 0',
        'export class Search extends BaseActivity {\n    private searchCount = 0\n    private memoryCritical = false',
        'memory critical state'
    )

    replaceOnce(
        '    public async doSearch(page: Page, isMobile: boolean): Promise<number> {\n        this.searchCount = 0',
        '    public async doSearch(page: Page, isMobile: boolean): Promise<number> {\n        this.searchCount = 0\n        this.memoryCritical = false',
        'search reset'
    )

    replaceOnce(
        "        } finally {\n            await page.goto(URLs.bing.origin).catch(() => {})\n        }",
        `        } finally {\n            const memory = sampleProcessMemory()\n            const skipFinalNavigation =\n                this.memoryCritical ||\n                (memory.containerUsagePercent !== null &&\n                    memory.containerUsagePercent >= CONTAINER_ABORT_THRESHOLD_PERCENT)\n\n            if (skipFinalNavigation) {\n                this.bot.logger.warn(\n                    isMobile,\n                    'MEMORY',\n                    \`Skipping post-search Bing navigation so browser cleanup can run immediately | \${this.formatMemory(memory)}\`\n                )\n            } else if (!page.isClosed()) {\n                await page\n                    .goto(URLs.bing.origin, { waitUntil: 'domcontentloaded', timeout: 5000 })\n                    .catch(() => {})\n            }\n        }`,
        'post-search navigation'
    )

    replaceOnce(
        '    public async doBonusSearches(page: Page): Promise<number> {\n        const isMobile = this.bot.isMobile\n        this.searchCount = 0',
        '    public async doBonusSearches(page: Page): Promise<number> {\n        const isMobile = this.bot.isMobile\n        this.searchCount = 0\n        this.memoryCritical = false',
        'bonus reset'
    )

    replaceOnce(
        `            const ready = await tracker.prepare()\n            if (!ready) return stats\n\n            const queryQueue = new SearchQueryQueue(this.bot)`,
        `            const ready = await tracker.prepare()\n            if (!ready) return stats\n\n            if (await this.handleMemoryPressure(page, isMobile)) {\n                this.bot.logger.warn(\n                    isMobile,\n                    tracker.context,\n                    \`Container memory too high to safely start Bing searches; returning immediately for browser cleanup | \${tracker.progress()}\`\n                )\n                return stats\n            }\n\n            const queryQueue = new SearchQueryQueue(this.bot)`,
        'pre-search memory guard'
    )

    replaceOnce(
        `        if (usage !== null && usage >= CONTAINER_ABORT_THRESHOLD_PERCENT) {\n            this.bot.logger.warn(`,
        `        if (usage !== null && usage >= CONTAINER_ABORT_THRESHOLD_PERCENT) {\n            this.memoryCritical = true\n            this.bot.logger.warn(`,
        'critical memory flag'
    )

    replaceOnce(
        `        if (after.containerUsagePercent !== null && after.containerUsagePercent >= CONTAINER_ABORT_THRESHOLD_PERCENT) {\n            this.bot.logger.warn(`,
        `        if (after.containerUsagePercent !== null && after.containerUsagePercent >= CONTAINER_ABORT_THRESHOLD_PERCENT) {\n            this.memoryCritical = true\n            this.bot.logger.warn(`,
        'post-recycle critical flag'
    )

    fs.writeFileSync(target, source)
    console.log('[render-patch] Critical-memory Bing search cleanup applied')
}

void main().catch(error => {
    console.error(`[render-patch] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
})
