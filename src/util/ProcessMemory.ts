import fs from 'node:fs'

export interface ProcessMemorySnapshot {
    nodeRssMb: number
    treeRssMb: number
    processCount: number
    containerCurrentMb: number | null
    containerLimitMb: number | null
    containerUsagePercent: number | null
}

const MAX_PROCESSES = 128
const BYTES_PER_MB = 1024 * 1024
const UNLIMITED_CGROUP_BYTES = 1n << 60n

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

function readCgroupValue(paths: string[]): bigint | null {
    for (const path of paths) {
        try {
            const raw = fs.readFileSync(path, 'utf8').trim()
            if (!raw || raw === 'max') return null
            return BigInt(raw)
        } catch {}
    }
    return null
}

function cgroupMemory(): Pick<
    ProcessMemorySnapshot,
    'containerCurrentMb' | 'containerLimitMb' | 'containerUsagePercent'
> {
    if (process.platform !== 'linux') {
        return {
            containerCurrentMb: null,
            containerLimitMb: null,
            containerUsagePercent: null
        }
    }

    const currentBytes = readCgroupValue([
        '/sys/fs/cgroup/memory.current',
        '/sys/fs/cgroup/memory/memory.usage_in_bytes'
    ])
    const rawLimitBytes = readCgroupValue([
        '/sys/fs/cgroup/memory.max',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes'
    ])
    const limitBytes = rawLimitBytes !== null && rawLimitBytes < UNLIMITED_CGROUP_BYTES ? rawLimitBytes : null

    const containerCurrentMb = currentBytes === null ? null : Number(currentBytes) / BYTES_PER_MB
    const containerLimitMb = limitBytes === null ? null : Number(limitBytes) / BYTES_PER_MB
    const containerUsagePercent =
        currentBytes !== null && limitBytes !== null && limitBytes > 0n
            ? (Number(currentBytes) / Number(limitBytes)) * 100
            : null

    return {
        containerCurrentMb,
        containerLimitMb,
        containerUsagePercent
    }
}

export function sampleProcessMemory(rootPid = process.pid): ProcessMemorySnapshot {
    const nodeRssMb = process.memoryUsage().rss / BYTES_PER_MB
    const container = cgroupMemory()

    if (process.platform !== 'linux') {
        return {
            nodeRssMb,
            treeRssMb: nodeRssMb,
            processCount: 1,
            ...container
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
        processCount: Math.max(1, visited.size),
        ...container
    }
}
