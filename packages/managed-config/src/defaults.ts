import { SYSTEM_ACTOR, type Store, type TriggerDocumentData } from '@holtkeeper/store'

/** A trigger an install starts with, as a panel document (ids as `triggerId` gives them). */
export interface DefaultTrigger {
  id: string
  data: TriggerDocumentData
}

/**
 * Triggers an install starts with: every new or moved tag gets a snapshot of the public API of its
 * packages; every new repository gets every analyzer that only reads, the Guide generator
 * included (once, on the default branch).
 */
export const defaultTriggers: DefaultTrigger[] = [
  { id: 'tag', data: { on: 'tag', analyzers: ['api-surface'] } },
  { id: 'new-repo', data: { on: 'newRepo' } },
]

/**
 * Analyzers a release adds to a default trigger that existing installs already have. Each is
 * applied once per store, like a default document.
 */
interface DefaultTriggerAddition {
  /** Unique; the marker is `defaultMarker(id)`. */
  id: string
  /** Id of the trigger document to extend. */
  trigger: string
  analyzers: string[]
}

/** Additions to the default triggers: the public API snapshot on every tag. */
const defaultTriggerAdditions: DefaultTriggerAddition[] = [
  { id: 'tag+api-surface', trigger: 'tag', analyzers: ['api-surface'] },
]

/** Key in `Store.kv` marking that one default trigger was considered; never expires. */
export const defaultMarker = (id: string) => `config:default-seeded:trigger:${id}`

export interface SeedDefaultsOptions {
  store: Pick<Store, 'config' | 'kv' | 'audit'>
  /** Analyzer kinds the server can run. */
  analyzers: readonly string[]
  triggers?: readonly DefaultTrigger[]
  additions?: readonly DefaultTriggerAddition[]
  now?: () => Date
}

/**
 * Writes each default trigger as a panel document the first time this store sees it, so later
 * releases add their new defaults to existing installs. Each is considered once (a marker per
 * document in `Store.kv`, taken atomically when the store supports `compareAndSet`): removing one
 * later does not bring it back, and a panel document with the same id is kept as it is. Analyzers
 * the server lacks are dropped. Analyses stay current through freshness, so no schedule is
 * seeded. Each of `additions` then appends its analyzers to an existing trigger document once, unless they are there already (written as `trigger:<id>+<kinds>`). Does nothing
 * without `config` or `kv`. Audits the run as `config.seed` by the system actor and resolves with
 * `<type>:<id>` of what it wrote.
 */
export async function seedDefaults({
  store,
  analyzers,
  triggers = defaultTriggers,
  additions = defaultTriggerAdditions,
  now = () => new Date(),
}: SeedDefaultsOptions): Promise<string[]> {
  const { config, kv } = store
  if (!config || !kv) return []
  const at = now().toISOString()

  const claim = async (id: string) => {
    const key = defaultMarker(id)
    if ((await kv.get(key)) !== undefined) return false
    if (kv.compareAndSet) return kv.compareAndSet(key, undefined, { at })
    await kv.set(key, { at })
    return true
  }

  const known = new Set(analyzers)
  const written: string[] = []
  for (const trigger of triggers) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of writes, in a stable order
    if (!(await claim(trigger.id))) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (await config.get('trigger', trigger.id)) continue
    const data =
      'analyzers' in trigger.data && trigger.data.analyzers
        ? { ...trigger.data, analyzers: trigger.data.analyzers.filter((kind) => known.has(kind)) }
        : trigger.data
    if ('analyzers' in data && data.analyzers && !data.analyzers.length) continue
    if ('analyzer' in data && !known.has(data.analyzer)) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    await config.put({ type: 'trigger', id: trigger.id, data, updatedAt: at, updatedBy: 'system' })
    written.push(`trigger:${trigger.id}`)
  }
  for (const addition of additions) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of writes, in a stable order
    if (!(await claim(addition.id))) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    const existing = await config.get('trigger', addition.trigger)
    if (!existing || !('analyzers' in existing.data) || !existing.data.analyzers) continue
    const present = existing.data.analyzers
    const missing = addition.analyzers.filter((kind) => known.has(kind) && !present.includes(kind))
    if (!missing.length) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    await config.put({
      type: 'trigger',
      id: addition.trigger,
      data: { ...existing.data, analyzers: [...present, ...missing] },
      updatedAt: at,
      updatedBy: 'system',
    })
    written.push(`trigger:${addition.trigger}+${missing.join(',')}`)
  }
  if (written.length)
    await store.audit.append({
      at,
      actor: SYSTEM_ACTOR,
      via: 'system',
      action: 'config.seed',
      target: { type: 'config' },
      outcome: 'ok',
      details: { documents: written },
    })
  return written
}

/** Ids of the schedules earlier releases seeded, which freshness replaces. */
export const retiredScheduleIds: readonly string[] = [
  'ci-jobs-nightly',
  'delivery-weekly',
  'security-weekly',
  'quality-weekly',
  'tests-weekly',
  'branches-weekly',
  'stack-weekly',
  'api-weekly',
  'usages-weekly',
  'assets-weekly',
  'browserslist-weekly',
  'renovate-nightly',
  'guide-weekly',
]

/** Key in `Store.kv` marking that `retireSeededSchedules` ran on this store; never expires. */
export const RETIRED_SCHEDULES_MARKER = 'config:retired-seeded-schedules'

/**
 * Deletes the schedule documents whose ids are exactly `retiredScheduleIds` and that were last
 * written by the system (a seed nobody edited since; a person's edit keeps it), once per store: a
 * marker in `Store.kv` is written only after every delete went through, so a run cut short is
 * repeated on the next start, and a schedule created after the marker under one of those ids
 * stays. Does nothing without `config` or `kv`. Audits the deletion as `config.retire-schedules`
 * by the system actor when it removed anything and resolves with the ids it removed.
 */
export async function retireSeededSchedules({
  store,
  ids = retiredScheduleIds,
  now = () => new Date(),
}: {
  store: Pick<Store, 'config' | 'kv' | 'audit'>
  ids?: readonly string[]
  now?: () => Date
}): Promise<string[]> {
  const { config, kv } = store
  if (!config || !kv) return []
  const at = now().toISOString()
  if ((await kv.get(RETIRED_SCHEDULES_MARKER)) !== undefined) return []
  const wanted = new Set(ids)
  const removed: string[] = []
  for (const doc of await config.list('schedule')) {
    if (!wanted.has(doc.id) || doc.updatedBy !== 'system') continue
    // oxlint-disable-next-line no-await-in-loop -- a handful of deletes, in a stable order
    await config.remove('schedule', doc.id)
    removed.push(doc.id)
  }
  if (removed.length)
    await store.audit.append({
      at,
      actor: SYSTEM_ACTOR,
      via: 'system',
      action: 'config.retire-schedules',
      target: { type: 'config' },
      outcome: 'ok',
      details: { schedules: removed },
    })
  await kv.set(RETIRED_SCHEDULES_MARKER, { at })
  return removed
}
