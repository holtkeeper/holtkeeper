import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { ScheduleDocumentData, Store, TriggerDocumentData } from '@holtkeeper/store'

/** A schedule an install starts with, as a panel document. */
export interface DefaultSchedule {
  id: string
  data: ScheduleDocumentData
}

/** A trigger an install starts with, as a panel document (ids as `triggerId` gives them). */
export interface DefaultTrigger {
  id: string
  data: TriggerDocumentData
}

const everyDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const nights = { allow: [{ days: [...everyDay], from: '01:00', to: '07:00' }] }

/**
 * Schedules an install starts with, every group, repository jobs spread over the night: CI job
 * history nightly, delivery metrics on Mondays, vulnerability audit and dependency graph on
 * Saturdays, code quality (without running tests), licenses and fleet drift on Sundays, test
 * coverage and frontend test ids on Wednesdays, branches to clean up on Tuesdays, the tech stack of
 * every group on Mondays, the public API of packages and its usage on Thursdays, images, fonts
 * and media on Fridays, the browserslist database on Tuesdays in repositories that use it, and
 * outdated dependencies (Renovate, report only) on weekday nights.
 * Analyzers the server does not have are dropped, schedules left empty are skipped.
 */
export const defaultSchedules: DefaultSchedule[] = [
  {
    id: 'ci-jobs-nightly',
    data: {
      name: 'CI jobs, nightly',
      enabled: true,
      analyzers: ['ci-jobs'],
      cron: '0 1 * * *',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'delivery-weekly',
    data: {
      name: 'Delivery, weekly',
      enabled: true,
      analyzers: ['delivery'],
      cron: '0 1 * * 1',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'security-weekly',
    data: {
      name: 'Audit and dependencies, weekly',
      enabled: true,
      analyzers: ['audit', 'depgraph'],
      cron: '0 1 * * 6',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'quality-weekly',
    data: {
      name: 'Quality, licenses and fleet, weekly',
      enabled: true,
      analyzers: ['quality', 'licenses', 'fleet'],
      options: { quality: { coverage: 'skip' } },
      cron: '0 1 * * 0',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'tests-weekly',
    data: {
      name: 'Test coverage and test ids, weekly',
      enabled: true,
      analyzers: ['coverage', 'testids'],
      cron: '0 1 * * 3',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'branches-weekly',
    data: {
      name: 'Branches to clean up, weekly',
      enabled: true,
      analyzers: ['branches'],
      cron: '0 1 * * 2',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'stack-weekly',
    data: {
      name: 'Tech stack, weekly',
      enabled: true,
      analyzers: ['stack'],
      cron: '0 1 * * 1',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'api-weekly',
    data: {
      name: 'Public API, weekly',
      enabled: true,
      analyzers: ['api-surface'],
      cron: '0 1 * * 4',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'usages-weekly',
    data: {
      name: 'Package usage, weekly',
      enabled: true,
      analyzers: ['usages'],
      cron: '0 2 * * 4',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'assets-weekly',
    data: {
      name: 'Assets, weekly',
      enabled: true,
      analyzers: ['assets'],
      cron: '0 1 * * 5',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'browserslist-weekly',
    data: {
      name: 'Browserslist database, weekly',
      enabled: true,
      analyzers: ['browserslist'],
      cron: '0 3 * * 2',
      windows: nights,
      spread: true,
    },
  },
  {
    id: 'renovate-nightly',
    data: {
      name: 'Dependency updates, weekday nights',
      enabled: true,
      analyzers: ['renovate'],
      cron: '0 2 * * 1-5',
      windows: nights,
      spread: true,
    },
  },
]

/**
 * Triggers an install starts with: every new or moved tag gets a changelog, a risk assessment and
 * a snapshot of the public API of its packages.
 */
export const defaultTriggers: DefaultTrigger[] = [
  { id: 'tag', data: { on: 'tag', analyzers: ['changelog', 'release-risk', 'api-surface'] } },
]

/**
 * Analyzers a release adds to a default trigger that existing installs already have. Each is
 * applied once per store, like a default document.
 */
interface DefaultTriggerAddition {
  /** Unique; the marker is `defaultMarker('trigger', id)`. */
  id: string
  /** Id of the trigger document to extend. */
  trigger: string
  analyzers: string[]
}

/** Additions to the default triggers: the public API snapshot on every tag. */
const defaultTriggerAdditions: DefaultTriggerAddition[] = [
  { id: 'tag+api-surface', trigger: 'tag', analyzers: ['api-surface'] },
]

/** Key in `Store.kv` of the first seeding, which covered the first three default schedules. */
export const SCHEDULES_MARKER = 'config:default-schedules-seeded'

const FIRST_SEEDED = ['ci-jobs-nightly', 'delivery-weekly', 'security-weekly']

/** Key in `Store.kv` marking that one default document was considered; never expires. */
export const defaultMarker = (type: 'schedule' | 'trigger', id: string) =>
  `config:default-seeded:${type}:${id}`

export interface SeedDefaultsOptions {
  store: Pick<Store, 'config' | 'kv' | 'activity'>
  file: HoltkeeperConfig
  /** Analyzer kinds the server can run. */
  analyzers: readonly string[]
  schedules?: readonly DefaultSchedule[]
  triggers?: readonly DefaultTrigger[]
  additions?: readonly DefaultTriggerAddition[]
  now?: () => Date
}

/**
 * Writes each default schedule and trigger as a panel document the first time this store sees
 * it, so later releases add their new defaults to existing installs. Each is considered once (a
 * marker per document in `Store.kv`, taken atomically when the store supports `compareAndSet`):
 * removing one later does not bring it back, and a panel document with the same id is kept as
 * it is. Schedules are skipped while the config file has its own; the tag trigger while the file
 * sets `jobs.onTag`. Analyzers the server lacks are dropped. Each of `additions` then appends its
 * analyzers to an existing trigger document once, unless they are there already (written as
 * `trigger:<id>+<kinds>`). Does nothing without `config` or
 * `kv`. Logs a `config.defaults.seeded` activity event and resolves with `<type>:<id>` of what
 * it wrote.
 */
export async function seedDefaults({
  store,
  file,
  analyzers,
  schedules = defaultSchedules,
  triggers = defaultTriggers,
  additions = defaultTriggerAdditions,
  now = () => new Date(),
}: SeedDefaultsOptions): Promise<string[]> {
  const { config, kv } = store
  if (!config || !kv) return []
  const at = now().toISOString()
  const legacy = (await kv.get(SCHEDULES_MARKER)) !== undefined

  const claim = async (type: 'schedule' | 'trigger', id: string) => {
    if (legacy && type === 'schedule' && FIRST_SEEDED.includes(id)) return false
    const key = defaultMarker(type, id)
    if ((await kv.get(key)) !== undefined) return false
    if (kv.compareAndSet) return kv.compareAndSet(key, undefined, { at })
    await kv.set(key, { at })
    return true
  }

  const known = new Set(analyzers)
  const written: string[] = []
  const fileSchedules = (file.jobs?.schedules.length ?? 0) > 0
  for (const schedule of schedules) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of writes, in a stable order
    if (fileSchedules || !(await claim('schedule', schedule.id))) continue
    const kinds = schedule.data.analyzers.filter((kind) => known.has(kind))
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (!kinds.length || (await config.get('schedule', schedule.id))) continue
    const options = Object.fromEntries(
      Object.entries(schedule.data.options ?? {}).filter(([kind]) => known.has(kind)),
    )
    // oxlint-disable-next-line no-await-in-loop -- see above
    await config.put({
      type: 'schedule',
      id: schedule.id,
      data: {
        ...schedule.data,
        analyzers: kinds,
        ...(Object.keys(options).length ? { options } : {}),
      },
      updatedAt: at,
      updatedBy: 'system',
    })
    written.push(`schedule:${schedule.id}`)
  }
  for (const trigger of triggers) {
    if (trigger.data.on === 'tag' && file.jobs?.onTag) continue
    // oxlint-disable-next-line no-await-in-loop -- a handful of writes, in a stable order
    if (!(await claim('trigger', trigger.id))) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (await config.get('trigger', trigger.id)) continue
    const data =
      'analyzers' in trigger.data
        ? { ...trigger.data, analyzers: trigger.data.analyzers.filter((kind) => known.has(kind)) }
        : trigger.data
    if ('analyzers' in data && !data.analyzers.length) continue
    if ('analyzer' in data && !known.has(data.analyzer)) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    await config.put({ type: 'trigger', id: trigger.id, data, updatedAt: at, updatedBy: 'system' })
    written.push(`trigger:${trigger.id}`)
  }
  for (const addition of additions) {
    if (addition.trigger === 'tag' && file.jobs?.onTag) continue
    // oxlint-disable-next-line no-await-in-loop -- a handful of writes, in a stable order
    if (!(await claim('trigger', addition.id))) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    const existing = await config.get('trigger', addition.trigger)
    if (!existing || !('analyzers' in existing.data)) continue
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
    await store.activity.append({
      at,
      actor: 'system',
      action: 'config.defaults.seeded',
      details: { documents: written },
    })
  return written
}
