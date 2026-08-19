async function main() {
    const fs = await import('node:fs')

    patchLogin(fs)
    patchSearchOnBing(fs)

    console.log('[render-patch] Final Free-tier mobile memory safeguards applied')
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

    if (source.includes('Skipping mobile Bing verification under memory pressure')) return

    source = replaceOnce(
        source,
        'const DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT = 78\n',
        'const DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT = 78\nconst MOBILE_BING_VERIFY_MEMORY_LIMIT_PERCENT = 90\n',
        'Login.ts mobile memory threshold'
    )

    source = replaceOnce(
        source,
        `    private desktopMemoryCritical(memory: ProcessMemorySnapshot): boolean {\n        return (\n            !this.bot.isMobile &&\n            memory.containerUsagePercent !== null &&\n            memory.containerUsagePercent >= DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT\n        )\n    }\n\n    private formatLoginMemory(memory: ProcessMemorySnapshot): string {`,
        `    private desktopMemoryCritical(memory: ProcessMemorySnapshot): boolean {\n        return (\n            !this.bot.isMobile &&\n            memory.containerUsagePercent !== null &&\n            memory.containerUsagePercent >= DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT\n        )\n    }\n\n    private mobileBingVerificationCritical(memory: ProcessMemorySnapshot): boolean {\n        return (\n            this.bot.isMobile &&\n            memory.containerUsagePercent !== null &&\n            memory.containerUsagePercent >= MOBILE_BING_VERIFY_MEMORY_LIMIT_PERCENT\n        )\n    }\n\n    private formatLoginMemory(memory: ProcessMemorySnapshot): string {`,
        'Login.ts mobile memory helper'
    )

    source = replaceOnce(
        source,
        `        if (this.desktopMemoryCritical(beforeBingVerification)) {\n            this.bot.logger.warn(\n                this.bot.isMobile,\n                'LOGIN-BING',\n                \`Skipping desktop Bing verification under memory pressure; Rewards landing is already authenticated | \${this.formatLoginMemory(beforeBingVerification)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n            )\n        } else {\n            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting Bing session verification')\n            await this.verifyBingSession(page, account)\n        }`,
        `        if (this.desktopMemoryCritical(beforeBingVerification)) {\n            this.bot.logger.warn(\n                this.bot.isMobile,\n                'LOGIN-BING',\n                \`Skipping desktop Bing verification under memory pressure; Rewards landing is already authenticated | \${this.formatLoginMemory(beforeBingVerification)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n            )\n        } else if (this.mobileBingVerificationCritical(beforeBingVerification)) {\n            this.bot.logger.warn(\n                this.bot.isMobile,\n                'LOGIN-BING',\n                \`Skipping mobile Bing verification under memory pressure; Rewards landing is already authenticated | \${this.formatLoginMemory(beforeBingVerification)} | threshold=\${MOBILE_BING_VERIFY_MEMORY_LIMIT_PERCENT}%\`\n            )\n        } else {\n            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting Bing session verification')\n            await this.verifyBingSession(page, account)\n        }`,
        'Login.ts mobile verification bypass'
    )

    source = replaceOnce(
        source,
        `        if (this.desktopMemoryCritical(beforeRewardsContext)) {\n            this.bot.logger.warn(\n                this.bot.isMobile,\n                'GET-REWARD-SESSION',\n                \`Skipping desktop rewards-context refresh under memory pressure; reusing context discovered during the mobile phase | \${this.formatLoginMemory(beforeRewardsContext)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n            )\n        } else {\n            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Acquiring rewards context')\n            await this.getRewardsSession(page)\n        }`,
        `        if (this.desktopMemoryCritical(beforeRewardsContext)) {\n            this.bot.logger.warn(\n                this.bot.isMobile,\n                'GET-REWARD-SESSION',\n                \`Skipping desktop rewards-context refresh under memory pressure; reusing context discovered during the mobile phase | \${this.formatLoginMemory(beforeRewardsContext)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n            )\n        } else {\n            if (this.mobileBingVerificationCritical(beforeRewardsContext)) {\n                this.bot.logger.warn(\n                    this.bot.isMobile,\n                    'GET-REWARD-SESSION',\n                    \`Mobile memory remains high; continuing required rewards-context bootstrap without extra Bing verification | \${this.formatLoginMemory(beforeRewardsContext)}\`\n                )\n            }\n            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Acquiring rewards context')\n            await this.getRewardsSession(page)\n        }`,
        'Login.ts preserve required mobile bootstrap'
    )

    source = replaceOnce(
        source,
        `            const beforeNavigation = sampleProcessMemory()\n            if (this.desktopMemoryCritical(beforeNavigation)) {\n                this.bot.logger.warn(\n                    this.bot.isMobile,\n                    'LOGIN-BING',\n                    \`Skipping Bing verification navigation because desktop memory is already high | \${this.formatLoginMemory(beforeNavigation)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n                )\n                return\n            }`,
        `            const beforeNavigation = sampleProcessMemory()\n            const verificationMemoryCritical =\n                this.desktopMemoryCritical(beforeNavigation) || this.mobileBingVerificationCritical(beforeNavigation)\n            if (verificationMemoryCritical) {\n                const threshold = this.bot.isMobile\n                    ? MOBILE_BING_VERIFY_MEMORY_LIMIT_PERCENT\n                    : DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT\n                this.bot.logger.warn(\n                    this.bot.isMobile,\n                    'LOGIN-BING',\n                    \`Skipping Bing verification navigation because memory is already high | \${this.formatLoginMemory(beforeNavigation)} | threshold=\${threshold}%\`\n                )\n                return\n            }`,
        'Login.ts verification navigation mobile guard'
    )

    source = replaceOnce(
        source,
        `                const loopMemory = sampleProcessMemory()\n                if (this.desktopMemoryCritical(loopMemory)) {\n                    this.bot.logger.warn(\n                        this.bot.isMobile,\n                        'LOGIN-BING',\n                        \`Stopping Bing verification because desktop memory became high | \${this.formatLoginMemory(loopMemory)} | threshold=\${DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT}%\`\n                    )\n                    return\n                }`,
        `                const loopMemory = sampleProcessMemory()\n                const loopMemoryCritical =\n                    this.desktopMemoryCritical(loopMemory) || this.mobileBingVerificationCritical(loopMemory)\n                if (loopMemoryCritical) {\n                    const threshold = this.bot.isMobile\n                        ? MOBILE_BING_VERIFY_MEMORY_LIMIT_PERCENT\n                        : DESKTOP_FINALIZE_MEMORY_LIMIT_PERCENT\n                    this.bot.logger.warn(\n                        this.bot.isMobile,\n                        'LOGIN-BING',\n                        \`Stopping Bing verification because memory became high | \${this.formatLoginMemory(loopMemory)} | threshold=\${threshold}%\`\n                    )\n                    return\n                }`,
        'Login.ts verification loop mobile guard'
    )

    fs.writeFileSync(target, source)
}

function patchSearchOnBing(fs) {
    const target = 'src/functions/activities/search/BrowserSearchOnBing.ts'
    let source = fs.readFileSync(target, 'utf8')

    if (source.includes('Skipped SearchOnBing | reason=interactive search unavailable')) return

    source = replaceOnce(
        source,
        `    private gainedPoints = 0\n    private success = false\n    private oldBalance = 0`,
        `    private gainedPoints = 0\n    private success = false\n    private skippedIncompatible = false\n    private oldBalance = 0`,
        'BrowserSearchOnBing.ts skip state'
    )

    source = replaceOnce(
        source,
        `        this.gainedPoints = 0\n        this.success = false`,
        `        this.gainedPoints = 0\n        this.success = false\n        this.skippedIncompatible = false`,
        'BrowserSearchOnBing.ts reset skip state'
    )

    source = replaceOnce(
        source,
        `            if (this.success) {\n                this.bot.logger.info(\n                    this.bot.isMobile,\n                    'SEARCH-ON-BING',\n                    \`Completed SearchOnBing | offerId=\${offerId} | pointsGained=\${this.gainedPoints} | currentBalance=\${this.bot.userData.currentPoints} | previousBalance=\${this.oldBalance}\`,\n                    'green'\n                )\n            } else {\n                this.bot.logger.warn(\n                    this.bot.isMobile,\n                    'SEARCH-ON-BING',\n                    \`Failed SearchOnBing | offerId=\${offerId} | pointsGained=\${this.gainedPoints} | currentBalance=\${this.bot.userData.currentPoints} | previousBalance=\${this.oldBalance}\`\n                )\n            }`,
        `            if (this.success) {\n                this.bot.logger.info(\n                    this.bot.isMobile,\n                    'SEARCH-ON-BING',\n                    \`Completed SearchOnBing | offerId=\${offerId} | pointsGained=\${this.gainedPoints} | currentBalance=\${this.bot.userData.currentPoints} | previousBalance=\${this.oldBalance}\`,\n                    'green'\n                )\n            } else if (this.skippedIncompatible) {\n                this.bot.logger.warn(\n                    this.bot.isMobile,\n                    'SEARCH-ON-BING',\n                    \`Skipped SearchOnBing | reason=interactive search unavailable | offerId=\${offerId} | pointsGained=\${this.gainedPoints} | currentBalance=\${this.bot.userData.currentPoints} | previousBalance=\${this.oldBalance}\`\n                )\n            } else {\n                this.bot.logger.warn(\n                    this.bot.isMobile,\n                    'SEARCH-ON-BING',\n                    \`Failed SearchOnBing | offerId=\${offerId} | pointsGained=\${this.gainedPoints} | currentBalance=\${this.bot.userData.currentPoints} | previousBalance=\${this.oldBalance}\`\n                )\n            }`,
        'BrowserSearchOnBing.ts skipped result wording'
    )

    source = replaceOnce(
        source,
        `        if (!searchReady) {\n            incompatibleSearchContexts.add(page.context())\n            this.bot.logger.warn(`,
        `        if (!searchReady) {\n            incompatibleSearchContexts.add(page.context())\n            this.skippedIncompatible = true\n            this.bot.logger.warn(`,
        'BrowserSearchOnBing.ts initial incompatible state'
    )

    source = replaceOnce(
        source,
        `                const searched = await this.typeSearch(page, query)\n                if (!searched) {\n                    this.bot.logger.warn(`,
        `                const searched = await this.typeSearch(page, query)\n                if (!searched) {\n                    this.skippedIncompatible = true\n                    this.bot.logger.warn(`,
        'BrowserSearchOnBing.ts interaction incompatible state'
    )

    fs.writeFileSync(target, source)
}

void main().catch(error => {
    console.error(`[render-patch] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
})
