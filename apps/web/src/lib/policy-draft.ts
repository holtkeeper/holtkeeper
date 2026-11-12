import type { PolicyDraftChange, Scope, SettingView } from '@holtkeeper/api'

/** The scope Policies edits for: the organization or one group. */
export type PolicyFocus = { kind: 'org' } | { kind: 'group'; group: string }

/** The stored scope of a focus. */
const focusScope = (focus: PolicyFocus): Scope =>
  focus.kind === 'org' ? { all: true } : { groups: [focus.group] }

/** Whether `scope` is exactly the focus's scope, not a broader or overlapping one. */
function isFocusScope(scope: Scope, focus: PolicyFocus): boolean {
  if (focus.kind === 'org') return scope.all === true
  return (
    !scope.all &&
    !scope.repos?.length &&
    scope.groups?.length === 1 &&
    scope.groups[0] === focus.group
  )
}

/** Unsaved edits per policy key at the current focus: the new value, or `null` to remove it. */
export type PolicyDraft = Readonly<Record<string, unknown>>

/** The stored entry of `key` at exactly the focus's scope, the newest when there are several. */
export function focusEntry(
  entries: readonly SettingView[],
  key: string,
  focus: PolicyFocus,
): SettingView | undefined {
  return entries
    .filter((entry) => entry.key === key && !entry.secret && isFocusScope(entry.scope, focus))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

/**
 * The value a key shows at the focus: the draft's edit, else the stored entry's value, else (for
 * a group) the organization's, else `fallback`. `inherited` tells whether it comes from a broader
 * entry or the default, so saving it creates an entry for the focus.
 */
export function draftValue(
  entries: readonly SettingView[],
  draft: PolicyDraft,
  key: string,
  focus: PolicyFocus,
  fallback: unknown,
): { value: unknown; inherited: boolean; edited: boolean } {
  if (key in draft && draft[key] !== null)
    return { value: draft[key], inherited: false, edited: true }
  const own = draft[key] === null ? undefined : focusEntry(entries, key, focus)
  if (own) return { value: own.value, inherited: false, edited: false }
  const org = focus.kind === 'group' ? focusEntry(entries, key, { kind: 'org' }) : undefined
  return { value: org ? org.value : fallback, inherited: true, edited: key in draft }
}

/** The draft with `key` set to `value`; setting it back to the stored value drops the edit. */
export function withEdit(
  entries: readonly SettingView[],
  draft: PolicyDraft,
  key: string,
  focus: PolicyFocus,
  value: unknown,
): PolicyDraft {
  const stored = focusEntry(entries, key, focus)
  const { [key]: _previous, ...rest } = draft
  if (stored && JSON.stringify(stored.value) === JSON.stringify(value)) return rest
  return { ...rest, [key]: value }
}

/** The draft with the focus's own entry of `key` removed, so broader entries apply again. */
export function withReset(
  entries: readonly SettingView[],
  draft: PolicyDraft,
  key: string,
  focus: PolicyFocus,
): PolicyDraft {
  const { [key]: _previous, ...rest } = draft
  return focusEntry(entries, key, focus) ? { ...rest, [key]: null } : rest
}

/** The changes `POST /api/settings/draft` needs to store the draft at the focus. */
export function draftChanges(
  entries: readonly SettingView[],
  draft: PolicyDraft,
  focus: PolicyFocus,
): PolicyDraftChange[] {
  const scope = focusScope(focus)
  return Object.entries(draft).flatMap(([key, value]): PolicyDraftChange[] => {
    const stored = focusEntry(entries, key, focus)
    if (value === null) return stored ? [{ op: 'remove', id: stored.id }] : []
    return [{ op: 'put', ...(stored && { id: stored.id }), key, scope, value }]
  })
}

/** How many keys the draft changes. */
export const draftCount = (draft: PolicyDraft): number => Object.keys(draft).length

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `value` as an object to read fields of; anything else reads as empty. */
export const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

/** A string list field of `value`, empty when it is missing or not a list of strings. */
export const listOf = (value: unknown, field: string): string[] => {
  const list = recordOf(value)[field]
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []
}

/** An allowlist entry as Policies edits it. */
export interface AllowlistRow {
  id: string
  reason: string
  package?: string
  expires?: string
  author?: string
}

/** The entries of an `audit.allowlist` value, skipping malformed ones. */
export function allowlistRows(value: unknown): AllowlistRow[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = recordOf(item)
    if (typeof record.id !== 'string' || typeof record.reason !== 'string') return []
    return [
      {
        ...record,
        id: record.id,
        reason: record.reason,
        ...(typeof record.package === 'string' && { package: record.package }),
        ...(typeof record.expires === 'string' && { expires: record.expires }),
      },
    ]
  })
}

/**
 * Why a new or changed allowlist entry would be refused by the allowlist rules: a blank reason
 * under `requireReason`, or no expiry or one past `maxDays` from `today` (`YYYY-MM-DD`). Mirrors
 * the server's check, so the form can say it before saving.
 */
export function allowlistRowProblem(
  rules: { maxDays?: number; requireReason?: boolean },
  row: Pick<AllowlistRow, 'reason' | 'expires'>,
  today: string,
): string | undefined {
  if (rules.requireReason !== false && !row.reason.trim()) return 'Give a reason'
  if (rules.maxDays === undefined) return undefined
  if (!row.expires) return `Set an expiry within ${rules.maxDays} days`
  const latest = new Date(Date.parse(today) + rules.maxDays * 86_400_000).toISOString().slice(0, 10)
  return row.expires > latest
    ? `Expires after ${latest}, past the ${rules.maxDays}-day limit`
    : undefined
}
