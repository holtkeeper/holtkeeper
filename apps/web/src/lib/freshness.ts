import type { StatusTone } from '../ui/colors.ts'

/**
 * How current a stored record is: `failed` when its last run failed, `never` without a record;
 * otherwise over a month old is `stale`, over a week `aging`, younger it is `behind` when it ran
 * on another commit than the known default-branch head, else `current`.
 */
export type Freshness = 'current' | 'behind' | 'aging' | 'stale' | 'failed' | 'never'

/** What freshness is judged from; `sha` is the commit the record ran on, when known. */
export interface FreshnessInput {
  createdAt?: string
  sha?: string
  failed?: boolean
}

const DAY = 86_400_000

/**
 * The freshness of a record against `head`, the default-branch head sha freshness last saw. A
 * record is only behind when both shas are known and differ.
 */
export function freshnessOf(
  record: FreshnessInput | undefined,
  head: string | undefined,
  now: Date = new Date(),
): Freshness {
  if (record?.failed) return 'failed'
  if (!record?.createdAt) return 'never'
  const age = now.getTime() - new Date(record.createdAt).getTime()
  if (age > 30 * DAY) return 'stale'
  if (age > 7 * DAY) return 'aging'
  return head && record.sha && record.sha !== head ? 'behind' : 'current'
}

export const freshnessTone: Record<Freshness, StatusTone> = {
  current: 'success',
  behind: 'info',
  aging: 'warning',
  stale: 'danger',
  failed: 'danger',
  never: 'default',
}

export const freshnessLabel: Record<Freshness, string> = {
  current: 'Current',
  behind: 'Behind HEAD',
  aging: 'Over a week old',
  stale: 'Over a month old',
  failed: 'Failed',
  never: 'Not analysed',
}

const rank: Record<Freshness, number> = {
  failed: 0,
  stale: 1,
  aging: 2,
  behind: 3,
  current: 4,
  never: 5,
}

/** Sort order, most worrying first: failed, stale, aging, behind, current, then never analysed. */
export const compareFreshness = (a: Freshness, b: Freshness): number => rank[a] - rank[b]
