async function main() {
    const fs = await import('node:fs')

    patchLogin(fs)
    patchSearchOnBing(fs)

    console.log('[render-patch] Free-tier login and SearchOnBing memory hardening applied')
}

function replaceOnce(source, oldText, newText, label) {
    const count = source.split(oldText).length - 1
    if (count !== 1) {
        throw new Error(`${label}: expected exactly one patch target, found ${count}`)
    }
    return source.replace(oldText, newText)
}

function patchLogin(fs) {
    const target = 'src/browser/auth/Login.ts'
    let source = fs.readFileSync(target, 'utf8')

    if (source.includes('Skipping desktop Bing verification under memory pressure')) {
        return
    }

    source = replaceOnce(
        source,
        "import { unknownPageDiagnostic } from '../../util/ErrorDiagnostic'\n",
        "import { unknownPageDiagnostic } from '../../util/ErrorDiagnostic'\nimport { sampleProcessMemory, type ProcessMemorySnapshot } from '../../util/ProcessMemory'\n",
        'Login.ts memory import'
    )

    source = replaceOnce(
        source,
        "import type { Account } from '../../interface/Account'\n\n",
        "import type { Account } from '../../interface/Account'\n\nconst DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT = 78\n\n",
        'Login.ts memory threshold'
    )

    source = replaceOnce(
        source,
        `    private async finalizeLogin(page: Page, account: Account) {`,
        `    private desktopMemoryCritical(memory: ProcessMemorySnapshot): boolean {\n        return (\n            !this.bot.isMobile &&\n            memory.containerUsagePercent !== null &&\n            memory.containerUsagePercent >= DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT\n        )\n    }\n\n    private formatLoginMemory(memory: ProcessMemorySnapshot): string {\n        const current = memory.containerCurrentMb === null ? 'n/a' : \`\${memory.containerCurrentMb.toFixed(1)}MB\`\n        const limit = memory.containerLimitMb === null ? 'n/a' : \`\${memory.containerLimitMb.toFixed(1)}MB\`\n        const percent =\n            memory.containerUsagePercent === null ? 'n/a' : \`\${memory.containerUsagePercent.toFixed(1)}%\`\n\n        return \`container=\${current}/\${limit} (\${percent}) | nodeRssMb=\${memory.nodeRssMb.toFixed(1)} | processes=\${memory.processCount}\`\n    }\n\n    private async finalizeLogin(page: Page, account: Account) {`,
        'Login.ts memory helpers'
    )

    source = replaceOnce(
        source,
        `        await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})\n\n        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting Bing session verification')\n        await this.verifyBingSession(page, account)\n\n        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Acquiring rewards context')\n        await this.getRewardsSession(page)`,
        `        await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})\n\n        const beforeBingVerification = sampleProcessMemory()\n        this.bot.logger.info(\n            this.bot.isMobile,\n            'LOGIN-MEMORY',\n            \`Login finalize memory | phase=before-bing-verification | \${this.formatLoginMemory(beforeBingVerification)}\`\n        )\n\n        if (this.desktopMemoryCritical(beforeBingVerification)) {\n            this.bot.logger.warn(\n                this.bot.isMobile,\n                'LOGIN-BING',\n                \`Skipping desktop Bing verification under memory pressure; Rewards landing is already authenticated | \${this.formatLoginMemory(beforeBingVerification)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n            )\n        } else {\n            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting Bing session verification')\n            await this.verifyBingSession(page, account)\n        }\n\n        const beforeRewardsContext = sampleProcessMemory()\n        this.bot.logger.info(\n            this.bot.isMobile,\n            'LOGIN-MEMORY',\n            \`Login finalize memory | phase=before-rewards-context | \${this.formatLoginMemory(beforeRewardsContext)}\`\n        )\n\n        if (this.desktopMemoryCritical(beforeRewardsContext)) {\n            this.bot.logger.warn(\n                this.bot.isMobile,\n                'GET-REWARD-SESSION',\n                \`Skipping desktop rewards-context refresh under memory pressure; reusing context discovered during the mobile phase | \${this.formatLoginMemory(beforeRewardsContext)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n            )\n        } else {\n            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Acquiring rewards context')\n            await this.getRewardsSession(page)\n        }`,
        'Login.ts finalize memory guard'
    )

    source = replaceOnce(
        source,
        `    async verifyBingSession(page: Page, account: Account) {\n        const url = URLs.auth.bingSignIn\n        const loopMax = 5`,
        `    async verifyBingSession(page: Page, account: Account) {\n        const url = this.bot.isMobile ? URLs.auth.bingSignIn : URLs.bing.origin\n        const loopMax = this.bot.isMobile ? 5 : 1`,
        'Login.ts lightweight desktop Bing verification'
    )

    source = replaceOnce(
        source,
        `        try {\n            await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})\n\n            for (let i = 0; i < loopMax; i++) {\n                if (page.isClosed()) break\n\n                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', \`Verification loop \${i + 1}/\${loopMax}\`)`,
        `        try {\n            const beforeNavigation = sampleProcessMemory()\n            if (this.desktopMemoryCritical(beforeNavigation)) {\n                this.bot.logger.warn(\n                    this.bot.isMobile,\n                    'LOGIN-BING',\n                    \`Skipping Bing verification navigation because desktop memory is already high | \${this.formatLoginMemory(beforeNavigation)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n                )\n                return\n            }\n\n            await page\n                .goto(url, {\n                    waitUntil: this.bot.isMobile ? 'networkidle' : 'domcontentloaded',\n                    timeout: this.bot.isMobile ? 10000 : 5000\n                })\n                .catch(() => {})\n\n            for (let i = 0; i < loopMax; i++) {\n                if (page.isClosed()) break\n\n                const loopMemory = sampleProcessMemory()\n                if (this.desktopMemoryCritical(loopMemory)) {\n                    this.bot.logger.warn(\n                        this.bot.isMobile,\n                        'LOGIN-BING',\n                        \`Stopping Bing verification because desktop memory became high | \${this.formatLoginMemory(loopMemory)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n                    )\n                    return\n                }\n\n                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', \`Verification loop \${i + 1}/\${loopMax}\`)`,
        'Login.ts Bing navigation memory guard'
    )

    fs.writeFileSync(target, source)
}

function patchSearchOnBing(fs) {
    const target = 'src/functions/activities/search/BrowserSearchOnBing.ts'
    let source = fs.readFileSync(target, 'utf8')

    if (source.includes('This browser context already proved incompatible with interactive SearchOnBing')) {
        return
    }

    source = replaceOnce(
        source,
        "import type { Page } from 'patchright'",
        "import type { BrowserContext, Page } from 'patchright'",
        'BrowserSearchOnBing.ts context type import'
    )

    source = replaceOnce(
        source,
        `const SEARCH_BOX_SELECTOR = '#sb_form_q, input[name="q"], textarea[name="q"], [role="searchbox"]'\n// Keep SearchOnBing on the interactive-search path; incompatible pages are skipped instead of URL-fallback loops.`,
        `const SEARCH_BOX_SELECTOR = '#sb_form_q, input[name="q"], textarea[name="q"], [role="searchbox"]'\nconst incompatibleSearchContexts = new WeakSet<BrowserContext>()\n// Keep SearchOnBing on the interactive-search path; incompatible pages are skipped instead of URL-fallback loops.`,
        'BrowserSearchOnBing.ts incompatible-context cache'
    )

    source = replaceOnce(
        source,
        `        this.bot.logger.info(\n            this.bot.isMobile,\n            'SEARCH-ON-BING',\n            \`Starting SearchOnBing | offerId=\${offerId} | title="\${promotion.title}" | currentBalance=\${this.oldBalance}\`\n        )\n\n        try {`,
        `        this.bot.logger.info(\n            this.bot.isMobile,\n            'SEARCH-ON-BING',\n            \`Starting SearchOnBing | offerId=\${offerId} | title="\${promotion.title}" | currentBalance=\${this.oldBalance}\`\n        )\n\n        if (incompatibleSearchContexts.has(page.context())) {\n            this.bot.logger.warn(\n                this.bot.isMobile,\n                'SEARCH-ON-BING-SEARCH',\n                \`This browser context already proved incompatible with interactive SearchOnBing; skipping offer without another Bing page load | offerId=\${offerId} | title="\${promotion.title}"\`\n            )\n            return\n        }\n\n        try {`,
        'BrowserSearchOnBing.ts cached skip'
    )

    source = replaceOnce(
        source,
        `        } finally {\n            await page.goto(URLs.rewards.earn).catch(() => {})\n        }`,
        `        } finally {\n            if (!page.isClosed()) {\n                await page\n                    .goto(URLs.rewards.earn, { waitUntil: 'domcontentloaded', timeout: 5000 })\n                    .catch(() => {})\n            }\n        }`,
        'BrowserSearchOnBing.ts bounded return navigation'
    )

    source = replaceOnce(
        source,
        `        const searchReady = await this.ensureSearchReady(page)\n        if (!searchReady) {\n            this.bot.logger.warn(`,
        `        const searchReady = await this.ensureSearchReady(page)\n        if (!searchReady) {\n            incompatibleSearchContexts.add(page.context())\n            this.bot.logger.warn(`,
        'BrowserSearchOnBing.ts mark incompatible context'
    )

    source = replaceOnce(
        source,
        `        const searchReady = await this.ensureSearchReady(page)\n        if (!searchReady) return false\n\n        const searchBox = page.locator(SEARCH_BOX_SELECTOR).first()`,
        `        const searchReady = await this.ensureSearchReady(page)\n        if (!searchReady) {\n            incompatibleSearchContexts.add(page.context())\n            return false\n        }\n\n        const searchBox = page.locator(SEARCH_BOX_SELECTOR).first()`,
        'BrowserSearchOnBing.ts mark interaction failure'
    )

    fs.writeFileSync(target, source)
}

void main().catch(error => {
    console.error(`[render-patch] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
})
