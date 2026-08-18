const fs = require('fs')

const target = 'src/browser/auth/Login.ts'
let source = fs.readFileSync(target, 'utf8')

const detectionMarker = '        // Microsoft can use the older account.live.com confirm-identity page for\n'
const detectionPatch = `        // Microsoft may interrupt a successful password sign-in with an optional\n        // passkey enrollment page. Treat that explicit URL as a passkey prompt so\n        // the existing passkey handler chooses the secondary/skip action instead\n        // of repeatedly pressing the primary enrollment button.\n        if (hostname === 'account.live.com' && url.pathname === '/interrupt/passkey/enroll') {\n            this.bot.logger.debug(\n                this.bot.isMobile,\n                'DETECT-STATE',\n                'Microsoft passkey enrollment interrupt detected'\n            )\n            return 'PASSKEY_VIDEO'\n        }\n\n`

if (!source.includes('Microsoft passkey enrollment interrupt detected')) {
    if (!source.includes(detectionMarker)) {
        throw new Error('Login.ts detection marker changed; refusing to patch passkey enrollment handling')
    }
    source = source.replace(detectionMarker, detectionPatch + detectionMarker)
}

const oldSecondarySelector = `        secondaryButton: 'button[data-testid="secondaryButton"]',`
const newSecondarySelector = `        secondaryButton: 'button[data-testid="secondaryButton"], button:has-text("Skip"), button:has-text("Not now"), button:has-text("Maybe later")',`

if (!source.includes(newSecondarySelector)) {
    if (!source.includes(oldSecondarySelector)) {
        throw new Error('Login.ts secondaryButton selector changed; refusing to patch passkey skip selector')
    }
    source = source.replace(oldSecondarySelector, newSecondarySelector)
}

fs.writeFileSync(target, source)
console.log('[render-patch] Microsoft passkey enrollment compatibility applied')
