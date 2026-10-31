import type { Agent } from '@holtkeeper/agent'
import { type CommandRunner, localRunner } from '@holtkeeper/exec'

import type { QualityCheck, QualityData } from './types.ts'

export interface AnalyzeQualityOptions {
  dir: string
  checks: readonly QualityCheck[]
  runner?: CommandRunner
  agent?: Agent
  signal?: AbortSignal
}

/** Stable short id from parts, for issues and changes that must keep their id across runs. */
export function stableId(...parts: (string | number | undefined)[]): string {
  return new Bun.CryptoHasher('sha256')
    .update(parts.map((p) => String(p ?? '')).join('\u0000'))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Runs every check that detects itself, one after another, and merges their results. A failing
 * check is recorded in `tools` and does not stop the others.
 */
export async function analyzeQuality({
  dir,
  checks,
  runner = localRunner,
  agent,
  signal,
}: AnalyzeQualityOptions): Promise<QualityData> {
  const data: QualityData = { tools: [], issues: [], tests: [], conventions: [], changes: [] }

  for (const check of checks) {
    signal?.throwIfAborted()
    // Checks run sequentially: several of them run package managers or test suites in `dir`.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await check.detect(dir))) continue
    const started = performance.now()
    try {
      // oxlint-disable-next-line no-await-in-loop
      const result = await check.run({
        dir,
        runner,
        ...(agent ? { agent } : {}),
        ...(signal ? { signal } : {}),
      })
      data.issues.push(...(result.issues ?? []))
      data.tests.push(...(result.tests ?? []))
      data.conventions.push(...(result.conventions ?? []))
      data.changes.push(...(result.changes ?? []))
      if (result.coverage) data.coverage = { ...data.coverage, ...result.coverage }
      if (result.duplication) data.duplication = result.duplication
      data.tools.push({
        name: check.name,
        ...(result.version ? { version: result.version } : {}),
        ok: true,
        ...(result.skipped ? { skipped: result.skipped } : {}),
        durationMs: Math.round(performance.now() - started),
      })
    } catch (error) {
      data.tools.push({
        name: check.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - started),
      })
    }
  }

  const seen = new Set<string>()
  data.changes = data.changes.filter((change) => !seen.has(change.id) && seen.add(change.id))
  return data
}
