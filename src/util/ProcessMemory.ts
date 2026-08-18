import fs from 'node:fs'

export interface ProcessMemorySnapshot {
    nodeRssMb: number
    treeRssMb: number
    processCount: number
}

const MAX_PROCESSES = 128

function rssKb(pid: number): number {
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
        return match ? Number(match[1]) : 0
    } catch {
        return 0
    }
}

function childPids(pid: number): number[] {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim()
        if (!raw) return []
        return raw
            .split(/\s+/)
            .map(Number)
            .filter(value => Number.isSafeInteger(value) && value > 0)
    } catch {
        return []
    }
}

export function sampleProcessMemory(rootPid = process.pid): ProcessMemorySnapshot {
    const nodeRssMb = process.memoryUsage().rss / 1024 / 1024

    if (process.platform !== 'linux') {
        return {
            nodeRssMb,
            treeRssMb: nodeRssMb,
            processCount: 1
        }
    }

    const pending = [rootPid]
    const visited = new Set<number>()
    let treeRssKb = 0

    while (pending.length && visited.size < MAX_PROCESSES) {
        const pid = pending.shift()
        if (!pid || visited.has(pid)) continue

        visited.add(pid)
        treeRssKb += rssKb(pid)

        for (const child of childPids(pid)) {
            if (!visited.has(child)) pending.push(child)
        }
    }

    return {
        nodeRssMb,
        treeRssMb: treeRssKb > 0 ? treeRssKb / 1024 : nodeRssMb,
        processCount: Math.max(1, visited.size)
    }
}
