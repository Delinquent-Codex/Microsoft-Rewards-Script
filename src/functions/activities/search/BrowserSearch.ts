import type { Locator, Page } from 'patchright'

import { URLs } from '../../../constants/urls'
import { SearchQueryQueue } from '../../SearchQueryQueue'
import { BaseActivity } from '../BaseActivity'
import { BonusTracker } from './BonusTracker'
import { SearchProgress } from './SearchProgress'
import type { SearchTracker } from '../../../interface/Search'
import type { MissingSearchPoints } from '../../../interface/Points'
import type { MicrosoftRewardsBot } from '../../../index'
import { sampleProcessMemory, type ProcessMemorySnapshot } from '../../../util/ProcessMemory'

const HARD_RECYCLE_EVERY = 5
const MAX_QUERY_ATTEMPTS = 2
const SEARCH_BOX_WAIT_MS = 4000
const CONTAINER_RECYCLE_THRESHOLD_PERCENT = 82
const CONTAINER_ABORT_THRESHOLD_PERCENT = 90
const FALLBACK_NODE_RSS_RECYCLE_MB = 260

const POINTS_MAX_SEARCHES = 100
const POINTS_STAGNANT_LIMIT = 10

const SEARCH_BOX_SELECTORS = ['#sb_form_q', 'input[name="q"]', 'textarea[name="q"]', '[role="searchbox"]'] as const
const RESULT_LINK = '#b_results .b_algo h2'

interface SessionStats {
    totalGained: number
    performed: number
    stagnant: number
}

interface SearchBoxMatch {
    locator: Locator
    selector: string
}

export class Search extends BaseActivity {
    private searchCount = 0

    public async doSearch(page: Page, isMobile: boolean): Promise<number> {
        this.searchCount = 0
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)
        this.bot.logger.info(isMobile, 'SEARCH-BING', `Starting Bing searches | currentBalance=${startBalance}`)
        this.logMemory(isMobile, 'search-start')

        const tracker = new PointsTracker(this.bot, isMobile)
        try {
            const stats = await this.runSearchSession(page, isMobile, tracker)

            if (stats.performed >= tracker.maxSearches && !tracker.done()) {
                this.bot.logger.warn(
                    isMobile,
                    tracker.context,
                    `Hit the ${tracker.maxSearches}-search ceiling with points still missing | ${tracker.progress()}`
                )
            }

            this.bot.logger.info(
                isMobile,
                tracker.context,
                `Completed Bing searches | pointsGained=${stats.totalGained} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${startBalance} | searches=${stats.performed} | ${tracker.progress()}`
            )
            this.logMemory(isMobile, 'search-finish')
            return stats.totalGained
        } finally {
            await page.goto(URLs.bing.origin).catch(() => {})
        }
    }

    public async doBonusSearches(page: Page): Promise<number> {
        const isMobile = this.bot.isMobile
        this.searchCount = 0
        const tracker = new BonusTracker(this.bot, isMobile)

        const stats = await this.runSearchSession(page, isMobile, tracker)

        // No active offer (or the feature is off): prepare() already logged why
        if (!tracker.started) return 0

        const done = tracker.done() && !tracker.offerLost
        const reason = done
            ? 'offer complete'
            : tracker.offerLost
              ? 'offer no longer present'
              : stats.performed >= tracker.maxSearches
                ? 'reached maxBonusSearches'
                : stats.stagnant >= tracker.stagnantLimit
                  ? `${tracker.stagnantLimit} idle searches`
                  : 'query pool exhausted'

        this.bot.logger.info(
            isMobile,
            tracker.context,
            `Bonus farming ${done ? 'complete' : 'stopped'} (${reason}) | pointsGained=${stats.totalGained} | currentBalance=${this.bot.userData.currentPoints} | ${tracker.progress()} | searches=${stats.performed}`,
            done || stats.totalGained > 0 ? 'green' : undefined
        )
        return stats.totalGained
    }

    private async runSearchSession(page: Page, isMobile: boolean, tracker: SearchTracker): Promise<SessionStats> {
        const stats: SessionStats = { totalGained: 0, performed: 0, stagnant: 0 }

        try {
            const ready = await tracker.prepare()
            if (!ready) return stats

            const queryQueue = new SearchQueryQueue(this.bot)
            const topicCount = await queryQueue.prepare()
            if (!topicCount) {
                this.bot.logger.warn(isMobile, tracker.context, 'No main search topics available, skipping')
                return stats
            }
            this.bot.logger.info(
                isMobile,
                tracker.context,
                `Query queue ready | mainTopics=${topicCount} | clusterSearch=${this.bot.config.searchSettings.clusterSearch}`
            )

            await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-COOKIE-SEED', true)
            await page.goto(URLs.bing.origin)
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)

            if (!(await this.ensureSearchReady(page, isMobile))) {
                this.bot.logger.warn(
                    isMobile,
                    tracker.context,
                    `Bing interactive search UI unavailable; stopping search session without counting failed searches | currentUrl=${page.url()}`
                )
                return stats
            }

            while (!tracker.done() && stats.performed < tracker.maxSearches && stats.stagnant < tracker.stagnantLimit) {
                if (await this.handleMemoryPressure(page, isMobile)) {
                    this.bot.logger.warn(
                        isMobile,
                        tracker.context,
                        `Stopping Bing searches to protect container memory | ${tracker.progress()}`
                    )
                    break
                }

                const query = await queryQueue.next()
                if (!query) {
                    this.bot.logger.warn(isMobile, tracker.context, 'Query queue exhausted, stopping')
                    break
                }

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-COOKIE-SEED', true)
                const searched = await this.bingSearch(page, query, isMobile)
                if (!searched) {
                    this.bot.logger.warn(
                        isMobile,
                        tracker.context,
                        `Bing interactive search unavailable after recovery attempt; stopping search session | query="${query}" | ${tracker.progress()}`
                    )
                    break
                }

                stats.performed++

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-COOKIE-CAPTURE')
                const gained = await tracker.measure()
                if (gained > 0) {
                    stats.stagnant = 0
                    stats.totalGained += gained
                    this.bot.logger.info(
                        isMobile,
                        tracker.context,
                        `pointsGained=${gained} | currentBalance=${this.bot.userData.currentPoints} | query="${query}" | ${tracker.progress()}`,
                        'green'
                    )
                } else {
                    stats.stagnant++
                    this.bot.logger.info(
                        isMobile,
                        tracker.context,
                        `no points ${stats.stagnant}/${tracker.stagnantLimit} | query="${query}" | ${tracker.progress()}`
                    )
                }

                if (await this.handleMemoryPressure(page, isMobile)) {
                    this.bot.logger.warn(
                        isMobile,
                        tracker.context,
                        `Stopping Bing searches after memory-pressure check | ${tracker.progress()}`
                    )
                    break
                }
            }

            return stats
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                tracker.context,
                `Search session error | ${error instanceof Error ? error.message : String(error)}`
            )
            return stats
        }
    }

    private async bingSearch(page: Page, query: string, isMobile: boolean): Promise<boolean> {
        if (this.searchCount > 0 && this.searchCount % HARD_RECYCLE_EVERY === 0) {
            await this.hardRecyclePage(page, isMobile, `periodic-${this.searchCount}`)
        }

        for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
            if (await this.handleMemoryPressure(page, isMobile)) return false

            const searchBox = await this.findSearchBox(page, SEARCH_BOX_WAIT_MS)
            if (!searchBox) {
                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `Search attempt ${attempt}/${MAX_QUERY_ATTEMPTS} unavailable: no visible interactive search box | query="${query}" | currentUrl=${page.url()}`
                )
                if (attempt < MAX_QUERY_ATTEMPTS) {
                    await this.hardRecyclePage(page, isMobile, 'search-ui-missing')
                    continue
                }
                return false
            }

            try {
                await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'auto' }))
                await page.keyboard.press('Home')

                await this.bot.utils.wait(500)
                await searchBox.locator.click({ clickCount: 3, timeout: 3000 })
                await searchBox.locator.fill('')

                await page.keyboard.type(query, { delay: this.bot.utils.randomDelay(45, 90) })
                await page.keyboard.press('Enter')
                await this.bot.utils.wait(3000)

                this.searchCount++

                if (this.bot.config.searchSettings.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(page, isMobile)
                }
                if (this.bot.config.searchSettings.clickRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.clickRandomLink(page, isMobile)
                }

                await this.bot.utils.wait(
                    this.bot.utils.randomDelay(
                        this.bot.config.searchSettings.searchDelay.min,
                        this.bot.config.searchSettings.searchDelay.max
                    )
                )

                return true
            } catch (error) {
                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `Search attempt ${attempt}/${MAX_QUERY_ATTEMPTS} interaction failed | selector=${searchBox.selector} | query="${query}" | ${error instanceof Error ? error.message : String(error)}`
                )
                if (attempt < MAX_QUERY_ATTEMPTS) {
                    await this.hardRecyclePage(page, isMobile, 'search-interaction-retry')
                }
            }
        }

        return false
    }

    private async ensureSearchReady(page: Page, isMobile: boolean): Promise<boolean> {
        if (await this.findSearchBox(page, SEARCH_BOX_WAIT_MS)) return true

        this.bot.logger.warn(
            isMobile,
            'SEARCH-BING',
            `Bing interactive search box not found; recycling page once before giving up | currentUrl=${page.url()}`
        )
        await this.hardRecyclePage(page, isMobile, 'initial-search-ui-missing')
        return Boolean(await this.findSearchBox(page, SEARCH_BOX_WAIT_MS))
    }

    private async findSearchBox(page: Page, timeoutMs: number): Promise<SearchBoxMatch | null> {
        const deadline = Date.now() + timeoutMs

        while (Date.now() < deadline) {
            if (page.isClosed()) return null

            for (const selector of SEARCH_BOX_SELECTORS) {
                const locator = page.locator(selector).first()
                if (await locator.isVisible().catch(() => false)) {
                    return { locator, selector }
                }
            }

            await this.bot.utils.wait(250)
        }

        return null
    }

    private async handleMemoryPressure(page: Page, isMobile: boolean): Promise<boolean> {
        const memory = sampleProcessMemory()
        const usage = memory.containerUsagePercent

        if (usage !== null && usage >= CONTAINER_ABORT_THRESHOLD_PERCENT) {
            this.bot.logger.warn(
                isMobile,
                'MEMORY',
                `Container memory critical; aborting Bing search phase before Render OOM kill | ${this.formatMemory(memory)} | abortThreshold=${CONTAINER_ABORT_THRESHOLD_PERCENT}%`
            )
            return true
        }

        const shouldRecycle =
            usage !== null
                ? usage >= CONTAINER_RECYCLE_THRESHOLD_PERCENT
                : memory.nodeRssMb >= FALLBACK_NODE_RSS_RECYCLE_MB

        if (!shouldRecycle) return false

        this.bot.logger.warn(
            isMobile,
            'MEMORY',
            `Elevated memory before/during Bing searches; recycling page | ${this.formatMemory(memory)} | recycleThreshold=${usage !== null ? `${CONTAINER_RECYCLE_THRESHOLD_PERCENT}%` : `${FALLBACK_NODE_RSS_RECYCLE_MB}MB node RSS`}`
        )
        await this.hardRecyclePage(page, isMobile, 'memory-pressure')

        const after = sampleProcessMemory()
        if (after.containerUsagePercent !== null && after.containerUsagePercent >= CONTAINER_ABORT_THRESHOLD_PERCENT) {
            this.bot.logger.warn(
                isMobile,
                'MEMORY',
                `Container memory remained critical after recycle; stopping Bing searches | ${this.formatMemory(after)}`
            )
            return true
        }

        return false
    }

    private async hardRecyclePage(page: Page, isMobile: boolean, reason: string): Promise<void> {
        const before = sampleProcessMemory()
        this.bot.logger.info(
            isMobile,
            'MEMORY',
            `Recycling Bing page | reason=${reason} | ${this.formatMemory(before)}`
        )

        for (const extraPage of page.context().pages()) {
            if (extraPage !== page) await extraPage.close().catch(() => {})
        }

        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {})
        await this.bot.utils.wait(250)
        await page.goto(URLs.bing.origin, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
        await this.bot.browser.utils.tryDismissAllMessages(page)

        const after = sampleProcessMemory()
        this.bot.logger.info(
            isMobile,
            'MEMORY',
            `Bing page recycled | reason=${reason} | ${this.formatMemory(after)}`
        )
    }

    private formatMemory(memory: ProcessMemorySnapshot): string {
        const containerCurrent =
            memory.containerCurrentMb === null ? 'n/a' : `${memory.containerCurrentMb.toFixed(1)}MB`
        const containerLimit = memory.containerLimitMb === null ? 'n/a' : `${memory.containerLimitMb.toFixed(1)}MB`
        const containerPercent =
            memory.containerUsagePercent === null ? 'n/a' : `${memory.containerUsagePercent.toFixed(1)}%`

        return `container=${containerCurrent}/${containerLimit} (${containerPercent}) | nodeRssMb=${memory.nodeRssMb.toFixed(1)} | treeRssEstimateMb=${memory.treeRssMb.toFixed(1)} | processes=${memory.processCount}`
    }

    private logMemory(isMobile: boolean, phase: string): void {
        const memory = sampleProcessMemory()
        this.bot.logger.info(isMobile, 'MEMORY', `Process memory | phase=${phase} | ${this.formatMemory(memory)}`)
    }

    private async randomScroll(page: Page, isMobile: boolean) {
        try {
            const viewportHeight = await page.evaluate(() => window.innerHeight)
            const totalHeight = await page.evaluate(() => document.body.scrollHeight)
            const scrollPos = Math.floor(Math.random() * Math.max(1, totalHeight - viewportHeight))
            await page.evaluate(pos => window.scrollTo({ left: 0, top: pos, behavior: 'auto' }), scrollPos)
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `Failed during random scroll | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async clickRandomLink(page: Page, isMobile: boolean) {
        try {
            const searchPageUrl = page.url()
            await this.bot.browser.utils.ghostClick(page, RESULT_LINK)
            await this.bot.utils.wait(this.bot.config.searchSettings.searchResultVisitTime)

            if (isMobile) {
                await page.goto(searchPageUrl)
            } else {
                const newTab = await this.bot.browser.utils.getLatestTab(page)
                await this.bot.browser.utils.closeTabs(newTab)
            }
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-CLICK',
                `Failed during random click | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}

class PointsTracker implements SearchTracker {
    public readonly context = 'SEARCH-BING'
    public readonly maxSearches = POINTS_MAX_SEARCHES
    public readonly stagnantLimit = POINTS_STAGNANT_LIMIT

    private missing: MissingSearchPoints = { mobilePoints: 0, desktopPoints: 0, edgePoints: 0, totalPoints: 0 }
    private readonly runOnZeroPoints: boolean
    private readonly searchProgress: SearchProgress

    constructor(
        private bot: MicrosoftRewardsBot,
        private isMobile: boolean
    ) {
        this.runOnZeroPoints = this.bot.config.searchSettings.runOnZeroPoints ?? false
        this.searchProgress = new SearchProgress(this.bot)
    }

    async prepare(): Promise<boolean> {
        this.missing = await this.searchProgress.getMissing(this.isMobile)
        this.bot.logger.info(
            this.isMobile,
            this.context,
            `Search points remaining | edge=${this.missing.edgePoints} | desktop=${this.missing.desktopPoints} | mobile=${this.missing.mobilePoints}`
        )

        if (this.missing.totalPoints <= 0) {
            if (!this.runOnZeroPoints) {
                this.bot.logger.info(
                    this.isMobile,
                    this.context,
                    'No search points to earn, skipping (runOnZeroPoints is disabled)'
                )
                return false
            }
            this.bot.logger.info(
                this.isMobile,
                this.context,
                'No search points reported, but runOnZeroPoints is enabled, searching anyway'
            )
        }
        return true
    }

    async measure(): Promise<number> {
        const updated = await this.searchProgress.getMissing(this.isMobile)
        const gained = Math.max(0, this.missing.totalPoints - updated.totalPoints)
        this.missing = updated

        if (gained > 0) {
            this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gained
            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
        }
        return gained
    }

    done(): boolean {
        return !this.runOnZeroPoints && this.missing.totalPoints <= 0
    }

    progress(): string {
        return `remaining=${this.missing.totalPoints}`
    }
}
