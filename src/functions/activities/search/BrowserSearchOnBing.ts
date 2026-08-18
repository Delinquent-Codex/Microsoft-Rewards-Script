import type { Page } from 'patchright'
import { BaseActivity } from '../BaseActivity'
import { activateSearchOnBing, findSearchOnBingOffer, getSearchOnBingQueries } from './SearchOnBingShared'
import { URLs } from '../../../constants/urls'

import type { BasePromotion } from '../../../interface/DashboardData'

const SEARCH_BOX_SELECTOR = '#sb_form_q, input[name="q"], textarea[name="q"], [role="searchbox"]'

export class SearchOnBing extends BaseActivity {
    private gainedPoints = 0
    private success = false
    private oldBalance = 0

    public async doSearchOnBing(promotion: BasePromotion, page: Page) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        this.gainedPoints = 0
        this.success = false

        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-ON-BING',
            `Starting SearchOnBing | offerId=${offerId} | title="${promotion.title}" | currentBalance=${this.oldBalance}`
        )

        try {
            const activated = await activateSearchOnBing(this.bot, promotion)
            if (!activated) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Search activity couldn't be activated, aborting | offerId=${offerId}`
                )
                return
            }

            const queries = await getSearchOnBingQueries(this.bot, promotion)
            await this.searchBing(page, queries, promotion)

            if (this.success) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Completed SearchOnBing | offerId=${offerId} | pointsGained=${this.gainedPoints} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${this.oldBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Failed SearchOnBing | offerId=${offerId} | pointsGained=${this.gainedPoints} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${this.oldBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-ON-BING',
                `Error in doSearchOnBing | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        } finally {
            await page.goto(URLs.rewards.earn).catch(() => {})
        }
    }

    private async searchBing(page: Page, queries: string[], promotion: BasePromotion) {
        queries = [...new Set(queries)]
        const offerId = promotion.offerId

        this.bot.logger.debug(
            this.bot.isMobile,
            'SEARCH-ON-BING-SEARCH',
            `Starting search loop | queriesCount=${queries.length} | targetPoints=${promotion.pointProgressMax} | currentBalance=${this.oldBalance}`
        )

        await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-ON-BING-COOKIE-SEED', true)
        await this.ensureSearchReady(page)

        let lastBalance = this.oldBalance
        let i = 0

        for (const query of queries) {
            try {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Processing query | query="${query}"`)

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-ON-BING-COOKIE-SEED', true)
                await this.typeSearch(page, query)

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-ON-BING-COOKIE-CAPTURE')
                const dashboard = (await this.bot.browser.func.getDashboardData()).dashboard
                const newBalance = dashboard.userStatus.availablePoints
                const offer = findSearchOnBingOffer(dashboard, offerId)

                const delta = newBalance - lastBalance
                if (delta > 0) {
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + delta
                    lastBalance = newBalance
                }
                this.bot.userData.currentPoints = newBalance
                this.gainedPoints = newBalance - this.oldBalance

                const offerProgress = offer ? `${offer.pointProgress}/${offer.pointProgressMax}` : 'unknown'
                const offerComplete =
                    !!offer &&
                    (offer.complete || (offer.pointProgressMax > 0 && offer.pointProgress >= offer.pointProgressMax))

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `Progress check | query="${query}" | offerProgress=${offerProgress} | offerComplete=${offerComplete} | currentBalance=${newBalance}`
                )

                if (offerComplete) {
                    this.success = true
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-SEARCH',
                        `SearchOnBing activity completed | pointsGained=${this.gainedPoints} | currentBalance=${newBalance} | query="${query}" | offerProgress=${offerProgress}`,
                        'green'
                    )
                    return
                }

                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `${++i}/${queries.length} | activity not complete | offerProgress=${offerProgress} | query="${query}"`
                )
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `Error during search loop | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            } finally {
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            }
        }

        this.bot.logger.warn(
            this.bot.isMobile,
            'SEARCH-ON-BING-SEARCH',
            `Finished all queries without completing the activity | queriesTried=${queries.length} | offerId=${offerId} | pointsGained=${this.gainedPoints} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${this.oldBalance}`
        )
    }

    private async ensureSearchReady(page: Page): Promise<boolean> {
        const searchBox = page.locator(SEARCH_BOX_SELECTOR).first()
        if (await searchBox.isVisible().catch(() => false)) return true

        await page.goto(URLs.bing.origin, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        await this.bot.browser.utils.tryDismissAllMessages(page)

        return await searchBox.isVisible().catch(() => false)
    }

    private async navigateSearchFallback(page: Page, query: string): Promise<void> {
        const searchUrl = `${URLs.bing.origin}/search?q=${encodeURIComponent(query)}`
        this.bot.logger.warn(
            this.bot.isMobile,
            'SEARCH-ON-BING-SEARCH',
            `Bing search box unavailable; using search URL fallback | currentUrl=${page.url()}`
        )

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
    }

    private async typeSearch(page: Page, query: string) {
        const searchReady = await this.ensureSearchReady(page)
        if (!searchReady) {
            await this.navigateSearchFallback(page, query)
            return
        }

        const searchBox = page.locator(SEARCH_BOX_SELECTOR).first()

        try {
            await searchBox.waitFor({ state: 'visible', timeout: 5000 })
            await this.bot.utils.wait(500)

            await searchBox.fill(query)
            await searchBox.press('Enter')
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'SEARCH-ON-BING-SEARCH',
                `Search box interaction failed; using URL fallback | message=${error instanceof Error ? error.message : String(error)}`
            )
            await this.navigateSearchFallback(page, query)
        }
    }
}
