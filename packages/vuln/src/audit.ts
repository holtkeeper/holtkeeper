import {
  type AllowlistEntry,
  type IgnoredFinding,
  type Traits,
  applyAllowlist,
} from './allowlist.ts'
import { findingKey, groupBySource } from './finding.ts'
import type { Finding, Fixer, Scanner } from './types.ts'

export interface AuditOptions {
  dir: string
  scanner: Scanner
  /** Tried in order for every source file; empty or omitted means report only. */
  fixers?: readonly Fixer[]
  allowlist?: readonly AllowlistEntry[]
  traits?: Traits
  now?: Date
  signal?: AbortSignal
}

export interface FixAttempt {
  fixer: string
  source: string
  /** Ids of findings handed to the fixer. */
  requested: string[]
  changedFiles: string[]
  fixed: string[]
  notes: string[]
  error?: string
}

export interface AuditReport {
  scanner: string
  /** Findings still present and not allowlisted, after fixing. */
  findings: Finding[]
  ignored: IgnoredFinding[]
  expired: AllowlistEntry[]
  fixes: FixAttempt[]
  /** Findings present before fixing and gone after the rescan. */
  resolved: Finding[]
  changedFiles: string[]
}

async function fixSource(
  dir: string,
  source: string,
  findings: Finding[],
  fixers: readonly Fixer[],
  signal: AbortSignal | undefined,
): Promise<FixAttempt[]> {
  const attempts: FixAttempt[] = []
  let pending = findings
  for (const fixer of fixers) {
    if (pending.length === 0) break
    if (!fixer.supports(source)) continue

    const attempt: FixAttempt = {
      fixer: fixer.name,
      source,
      requested: pending.map((f) => f.id),
      changedFiles: [],
      fixed: [],
      notes: [],
    }
    try {
      // Fixers run one after another: each one sees what the previous one left unfixed.
      // oxlint-disable-next-line no-await-in-loop
      Object.assign(attempt, await fixer.fix({ dir, source, findings: pending, signal }))
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error)
    }
    attempts.push(attempt)

    const fixed = new Set(attempt.fixed)
    pending = pending.filter((finding) => !fixed.has(finding.id))
  }
  return attempts
}

/**
 * Scans a project, hides allowlisted findings and, when fixers are given, tries to fix the rest
 * and rescans to report what actually went away.
 */
export async function runAudit(options: AuditOptions): Promise<AuditReport> {
  const { dir, scanner, fixers = [], allowlist = [], traits, now, signal } = options
  const filter = (findings: Finding[]) => applyAllowlist(findings, allowlist, { now, traits })

  const initial = filter(await scanner.scan(dir, { signal }))
  if (fixers.length === 0 || initial.active.length === 0) {
    return {
      scanner: scanner.name,
      findings: initial.active,
      ignored: initial.ignored,
      expired: initial.expired,
      fixes: [],
      resolved: [],
      changedFiles: [],
    }
  }

  const fixes: FixAttempt[] = []
  for (const [source, findings] of groupBySource(initial.active)) {
    signal?.throwIfAborted()
    // Sources are fixed sequentially because package managers lock shared caches and workspaces.
    // oxlint-disable-next-line no-await-in-loop
    fixes.push(...(await fixSource(dir, source, findings, fixers, signal)))
  }

  const changedFiles = [...new Set(fixes.flatMap((attempt) => attempt.changedFiles))]
  if (changedFiles.length === 0) {
    return {
      scanner: scanner.name,
      findings: initial.active,
      ignored: initial.ignored,
      expired: initial.expired,
      fixes,
      resolved: [],
      changedFiles,
    }
  }

  const final = filter(await scanner.scan(dir, { signal }))
  const remaining = new Set(final.active.map(findingKey))
  return {
    scanner: scanner.name,
    findings: final.active,
    ignored: final.ignored,
    expired: final.expired,
    fixes,
    resolved: initial.active.filter((finding) => !remaining.has(findingKey(finding))),
    changedFiles,
  }
}
