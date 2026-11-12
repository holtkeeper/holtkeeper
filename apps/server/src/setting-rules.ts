import { type RepoTarget, type Scope, scopeWithin } from '@holtkeeper/access'
import {
  type AllowlistPolicy,
  type SettingDefinition,
  allowlistPolicySchema,
  resolveGlobalSetting,
  settingCascade,
} from '@holtkeeper/settings'
import type { SettingEntry } from '@holtkeeper/store'
import { type AllowlistEntry, allowlistSchema } from '@holtkeeper/vuln'

/**
 * Every entry of `definition` covering `target`, the one that applies first, as
 * `GET /api/settings/resolve`, MCP and chat tools resolve settings: most specific scope, then most
 * recently updated; a `global` setting counts only entries scoped `{ all: true }`.
 */
export const cascadeFor = (
  entries: readonly SettingEntry[],
  definition: Pick<SettingDefinition, 'key' | 'global'>,
  target: RepoTarget,
): SettingEntry[] =>
  settingCascade(entries, definition.key, target).filter(
    (entry) => !definition.global || entry.scope.all === true,
  )

/** The entry of `definition` that applies to `target`, per `cascadeFor`. */
export const applyingEntry = (
  entries: readonly SettingEntry[],
  definition: Pick<SettingDefinition, 'key' | 'global'>,
  target: RepoTarget,
): SettingEntry | undefined => cascadeFor(entries, definition, target)[0]

/** The organization's entry of `key`: the newest one scoped `{ all: true }`, never a secret. */
export const orgEntry = (entries: readonly SettingEntry[], key: string): SettingEntry | undefined =>
  resolveGlobalSetting(
    entries.filter((entry) => !entry.secret),
    key,
  )

const ALLOWLIST_POLICY = 'audit.allowlistPolicy'
const DAY_MS = 86_400_000

/**
 * The `audit.allowlistPolicy` that governs allowlist entries stored with `scope`: the strictest
 * combination of every entry whose scope contains it (the smallest `maxDays`, a reason when any
 * entry asks for one), so a narrower scope can tighten the rules but never loosen them; the
 * setting's default when no entry covers it.
 */
export function allowlistPolicyFor(
  entries: readonly SettingEntry[],
  scope: Scope,
): AllowlistPolicy {
  const policies = entries.flatMap((candidate) => {
    if (candidate.key !== ALLOWLIST_POLICY || candidate.secret) return []
    if (!scopeWithin(scope, candidate.scope)) return []
    const parsed = allowlistPolicySchema.safeParse(candidate.value)
    return parsed.success ? [parsed.data] : []
  })
  if (policies.length === 0) return allowlistPolicySchema.parse({})
  const days = policies.flatMap((policy) => (policy.maxDays === undefined ? [] : [policy.maxDays]))
  return {
    ...(days.length > 0 && { maxDays: Math.min(...days) }),
    requireReason: policies.some((policy) => policy.requireReason),
  }
}

/**
 * Why `entry`, added or changed today (`YYYY-MM-DD`), breaks `policy`: a blank reason under
 * `requireReason`, or no expiry or one later than `maxDays` from today. `undefined` when it passes.
 */
export function allowlistEntryProblem(
  policy: AllowlistPolicy,
  entry: Pick<AllowlistEntry, 'id' | 'reason' | 'expires'>,
  today: string,
): string | undefined {
  if (policy.requireReason && !entry.reason.trim())
    return `allowlist entry ${entry.id} needs a reason`
  if (policy.maxDays === undefined) return undefined
  const latest = new Date(Date.parse(today) + policy.maxDays * DAY_MS).toISOString().slice(0, 10)
  if (!entry.expires)
    return `allowlist entry ${entry.id} needs an expiry date, at most ${policy.maxDays} days ahead`
  if (entry.expires > latest)
    return `allowlist entry ${entry.id} must expire by ${latest} (at most ${policy.maxDays} days ahead)`
  return undefined
}

/** The first problem of the entries `after` adds or changes compared with `before`. */
export function allowlistProblem(
  policy: AllowlistPolicy,
  before: unknown,
  after: readonly AllowlistEntry[],
  today: string,
): string | undefined {
  const parsed = allowlistSchema.safeParse(before)
  const previous = parsed.success ? parsed.data : []
  for (const entry of after) {
    const known = previous.find(
      (candidate) => candidate.id === entry.id && candidate.package === entry.package,
    )
    if (known && known.reason === entry.reason && known.expires === entry.expires) continue
    const problem = allowlistEntryProblem(policy, entry, today)
    if (problem) return problem
  }
  return undefined
}
