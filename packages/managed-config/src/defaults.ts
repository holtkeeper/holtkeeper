import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { ScheduleDocumentData, Store } from '@holtkeeper/store'

/** A schedule a fresh install starts with, as a panel document. */
export interface DefaultSchedule {
  id: string
  data: ScheduleDocumentData
}

const everyDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const nights = { allow: [{ days: [...everyDay], from: '01:00', to: '07:00' }] }

/**
 * Schedules a fresh install starts with, every group, repository jobs spread over the night:
 * CI job history nightly, delivery metrics on Mondays, vulnerability audit and dependency graph on
 * Saturdays. Analyzers the server does not have are dropped, schedules left empty are skipped.
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
]

/** Key in `Store.kv` marking that default schedules were considered; never expires. */
export const SCHEDULES_MARKER = 'config:default-schedules-seeded'

export interface SeedSchedulesOptions {
  store: Pick<Store, 'config' | 'kv' | 'activity'>
  file: HoltkeeperConfig
  /** Analyzer kinds the server can run. */
  analyzers: readonly string[]
  schedules?: readonly DefaultSchedule[]
  now?: () => Date
}

/**
 * Writes `schedules` as panel documents once per store, when neither the config file nor the
 * panel has any schedule. The first call records a marker in `Store.kv` (atomically when it
 * supports `compareAndSet`), so removing the defaults later does not bring them back. Does
 * nothing without `config` or `kv`. Logs a `config.schedules.seeded` activity event and resolves
 * with the ids written.
 */
export async function seedDefaultSchedules({
  store,
  file,
  analyzers,
  schedules = defaultSchedules,
  now = () => new Date(),
}: SeedSchedulesOptions): Promise<string[]> {
  const { config, kv } = store
  if (!config || !kv) return []
  const at = now().toISOString()
  if ((await kv.get(SCHEDULES_MARKER)) !== undefined) return []
  if (kv.compareAndSet) {
    if (!(await kv.compareAndSet(SCHEDULES_MARKER, undefined, { at }))) return []
  } else await kv.set(SCHEDULES_MARKER, { at })
  if ((file.jobs?.schedules.length ?? 0) > 0) return []
  if ((await config.list('schedule')).length > 0) return []

  const known = new Set(analyzers)
  const written: string[] = []
  for (const schedule of schedules) {
    const kinds = schedule.data.analyzers.filter((kind) => known.has(kind))
    if (!kinds.length) continue
    // oxlint-disable-next-line no-await-in-loop -- a handful of writes, in a stable order
    await config.put({
      type: 'schedule',
      id: schedule.id,
      data: { ...schedule.data, analyzers: kinds },
      updatedAt: at,
      updatedBy: 'system',
    })
    written.push(schedule.id)
  }
  if (written.length)
    await store.activity.append({
      at,
      actor: 'system',
      action: 'config.schedules.seeded',
      details: { ids: written },
    })
  return written
}
