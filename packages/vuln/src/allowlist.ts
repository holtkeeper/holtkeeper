import { z } from 'zod'

import { matchesId } from './finding.ts'
import type { Finding } from './types.ts'

export type Traits = Record<string, string | number | boolean>

export const allowlistEntrySchema = z.object({
  /** Advisory id or any of its aliases. */
  id: z.string().min(1),
  reason: z.string().min(1),
  author: z.string().optional(),
  /** Last day the entry applies, `YYYY-MM-DD`. */
  expires: z.iso.date().optional(),
  /** Limit the entry to one package. */
  package: z.string().optional(),
  /** Limit the entry to source files matching these globs. */
  paths: z.array(z.string()).optional(),
  /** Apply only to repositories whose traits have all these values, e.g. `{ ssr: false }`. */
  when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})

export const allowlistSchema = z.array(allowlistEntrySchema)

export type AllowlistEntry = z.output<typeof allowlistEntrySchema>

export interface IgnoredFinding {
  finding: Finding
  entry: AllowlistEntry
}

export interface AllowlistResult {
  active: Finding[]
  ignored: IgnoredFinding[]
  /** Entries past their expiry date. They no longer hide anything. */
  expired: AllowlistEntry[]
}

export interface AllowlistOptions {
  now?: Date
  traits?: Traits
}

export const isExpired = (entry: AllowlistEntry, now: Date) =>
  entry.expires !== undefined && new Date(`${entry.expires}T23:59:59.999Z`) < now

function applies(entry: AllowlistEntry, finding: Finding, traits: Traits) {
  if (!matchesId(finding, entry.id)) return false
  if (entry.package !== undefined && entry.package !== finding.package.name) return false
  if (entry.paths && !entry.paths.some((p) => new Bun.Glob(p).match(finding.source))) return false
  return Object.entries(entry.when ?? {}).every(([trait, value]) => traits[trait] === value)
}

/** Splits findings into those still active and those hidden by a valid allowlist entry. */
export function applyAllowlist(
  findings: readonly Finding[],
  entries: readonly AllowlistEntry[],
  { now = new Date(), traits = {} }: AllowlistOptions = {},
): AllowlistResult {
  const valid = entries.filter((entry) => !isExpired(entry, now))
  const result: AllowlistResult = {
    active: [],
    ignored: [],
    expired: entries.filter((entry) => isExpired(entry, now)),
  }
  for (const finding of findings) {
    const entry = valid.find((candidate) => applies(candidate, finding, traits))
    if (entry) result.ignored.push({ finding, entry })
    else result.active.push(finding)
  }
  return result
}
