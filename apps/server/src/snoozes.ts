import type { Snooze } from '@holtkeeper/api'
import { type KvStore, updateKv } from '@holtkeeper/store'
import { z } from 'zod'

/** Snoozes one principal may keep at once; the ones ending soonest are dropped first. */
const MAX_SNOOZES = 500

const storedSchema = z.array(z.object({ id: z.string(), until: z.string() }))

const keyOf = (principalId: string) => `snooze:${principalId}`

const soonestFirst = (a: Snooze, b: Snooze) =>
  a.until.localeCompare(b.until) || a.id.localeCompare(b.id)

const live = (value: unknown, now: Date): Snooze[] => {
  const parsed = storedSchema.safeParse(value)
  if (!parsed.success) return []
  return parsed.data
    .filter((snooze) => Date.parse(snooze.until) > now.getTime())
    .toSorted(soonestFirst)
}

/**
 * The snooze id of a job failure on Home: `job-failures:<analyzer>:<signature>`, or
 * `job-failures:<analyzer>:<repo>` (`forge:path`) when the failure has no signature.
 */
export const failureSnoozeId = (failure: {
  analyzer: string
  signature?: string
  repo: string
}): string => `job-failures:${failure.analyzer}:${failure.signature ?? failure.repo}`

/** The principal's snoozes that have not run out at `now`, soonest to end first. */
export async function listSnoozes(
  kv: Pick<KvStore, 'get'> | undefined,
  principalId: string,
  now: Date,
): Promise<Snooze[]> {
  return kv ? live(await kv.get(keyOf(principalId)), now) : []
}

/** Ids the principal snoozed that have not run out at `now`; Home and Inbox mark them `snoozed`. */
export async function snoozedIds(
  kv: Pick<KvStore, 'get'> | undefined,
  principalId: string,
  now: Date,
): Promise<Set<string>> {
  return new Set((await listSnoozes(kv, principalId, now)).map((snooze) => snooze.id))
}

/** Thrown when concurrent writes kept a snooze change from landing. */
export class SnoozeConflictError extends Error {}

async function change(
  kv: KvStore,
  principalId: string,
  now: Date,
  apply: (snoozes: Snooze[]) => Snooze[],
): Promise<Snooze[]> {
  const next = await updateKv(kv, keyOf(principalId), (before) =>
    apply(live(before, now)).slice(-MAX_SNOOZES),
  )
  if (!next) throw new SnoozeConflictError('snoozes changed meanwhile; try again')
  return next
}

/** Snoozes `snooze.id` until `snooze.until`, replacing an earlier snooze of the same id. */
export async function addSnooze(
  kv: KvStore,
  principalId: string,
  snooze: Snooze,
  now: Date,
): Promise<Snooze[]> {
  return change(kv, principalId, now, (snoozes) =>
    [...snoozes.filter((each) => each.id !== snooze.id), snooze].toSorted(soonestFirst),
  )
}

/** Ends the principal's snooze of `id`; nothing happens when there is none. */
export async function removeSnooze(
  kv: KvStore,
  principalId: string,
  id: string,
  now: Date,
): Promise<Snooze[]> {
  return change(kv, principalId, now, (snoozes) => snoozes.filter((each) => each.id !== id))
}
