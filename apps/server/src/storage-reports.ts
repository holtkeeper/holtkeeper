import { link, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

import type { StorageDetailView, StorageProviderView } from '@holtkeeper/api'
import type { StorageProvider } from '@holtkeeper/artifacts'
import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

const REPORTS_KEY = 'storage:reports'
const CLEARS_KEY = 'storage:clears'
const KEEP_CLEARS_MS = 3_600_000

const usageSchema = z.object({
  bytes: z.number(),
  count: z.number().optional(),
  details: z
    .array(z.object({ label: z.string(), bytes: z.number(), count: z.number().optional() }))
    .optional(),
  available: z.boolean().optional(),
  note: z.string().optional(),
})

const reportSchema = z.object({
  worker: z.string(),
  at: z.string(),
  providers: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      clearable: z.boolean(),
      /** Id of the volume the area lives on; workers sharing one report the same id. */
      volume: z.string().optional(),
      usage: usageSchema.optional(),
      error: z.string().optional(),
    }),
  ),
})

const reportsSchema = z.object({ reports: z.record(z.string(), reportSchema) })

const clearRequestSchema = z.object({
  id: z.string(),
  provider: z.string(),
  scope: z.string().optional(),
  at: z.string(),
})

const clearsSchema = z.object({ requests: z.array(clearRequestSchema) })

/** What one worker process last measured of its own disks. */
export type WorkerStorageReport = z.infer<typeof reportSchema>

type Kv = Pick<KvStore, 'get' | 'set' | 'compareAndSet'>

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const VOLUME_FILE = '.holtkeeper-volume'

/**
 * The id in `dir/.holtkeeper-volume`, created once by whichever process gets there first: the
 * file is written aside and hard-linked into place, so nobody reads it half written.
 */
async function volumeId(dir: string): Promise<string | undefined> {
  const path = join(dir, VOLUME_FILE)
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  if (existing) return existing
  const aside = `${path}.${crypto.randomUUID()}`
  try {
    await writeFile(aside, crypto.randomUUID())
    await link(aside, path)
  } catch {
    // Another worker linked its id first, or the directory does not exist yet.
  } finally {
    await rm(aside, { force: true })
  }
  return (await readFile(path, 'utf8').catch(() => undefined)) || undefined
}

/** Workers of fresh `reports` that see `provider` on `volume`, by name. */
const sharing = (reports: readonly WorkerStorageReport[], provider: string, volume: string) =>
  reports
    .filter((report) =>
      report.providers.some((entry) => entry.id === provider && entry.volume === volume),
    )
    .map((report) => report.worker)
    .toSorted()

/** Read-modify-write of one key, atomic where the store has `compareAndSet`. */
async function update<T>(
  kv: Kv,
  key: string,
  schema: z.ZodType<T>,
  change: (current: T | undefined) => T,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const raw = await kv.get(key)
    const next = change(schema.safeParse(raw).data)
    if (!kv.compareAndSet) return kv.set(key, next)
    if (await kv.compareAndSet(key, raw, next)) return
  }
  throw new Error(`${key} kept changing under concurrent writers`)
}

export interface StorageReportsOptions {
  kv: Kv
  /** Areas on this process's own disks, e.g. git mirrors and the mise tool cache. */
  providers: StorageProvider[]
  /**
   * Directory of each provider id. A `.holtkeeper-volume` file there identifies the volume, so an
   * area shared by several workers (a ReadWriteMany volume) is counted and cleared once.
   */
  directories?: Record<string, string>
  /** Default: the host name, which is the pod name in Kubernetes. */
  worker?: string
  /** How often usage is measured and published. Default 5 minutes. */
  intervalMs?: number
  /** How often clear requests are looked for. Default 15 seconds. */
  pollMs?: number
  now?: () => Date
  log?: (line: string) => void
}

/**
 * Publishes what `providers` use on this worker every `intervalMs` (and at once), so web
 * processes, which cannot see worker disks, can show them; reports expire after three intervals
 * without an update. Carries out clear requests made after it started through
 * `requestStorageClear`, then publishes again. Returns a stop function, which also drops this
 * worker's report, so a stopped pod disappears from the overview at once.
 */
export function startStorageReports(options: StorageReportsOptions): () => Promise<void> {
  const { kv, providers } = options
  const worker = options.worker ?? hostname()
  const intervalMs = options.intervalMs ?? 300_000
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const startedAt = now().toISOString()
  const handled = new Set<string>()
  let running: Promise<void> = Promise.resolve()

  const measure = async (): Promise<WorkerStorageReport> => ({
    worker,
    at: now().toISOString(),
    providers: await Promise.all(
      providers.map(async (provider) => {
        const dir = options.directories?.[provider.id]
        const volume = dir ? await volumeId(dir) : undefined
        const base = {
          id: provider.id,
          label: provider.label,
          clearable: !!provider.clear,
          ...(volume ? { volume } : {}),
        }
        try {
          return { ...base, usage: await provider.usage() }
        } catch (error) {
          return { ...base, error: message(error) }
        }
      }),
    ),
  })

  const publish = async () => {
    const report = await measure()
    const staleBefore = now().getTime() - 3 * intervalMs
    await update(kv, REPORTS_KEY, reportsSchema, (current) => ({
      reports: {
        ...Object.fromEntries(
          Object.entries(current?.reports ?? {}).filter(
            ([, entry]) => Date.parse(entry.at) >= staleBefore,
          ),
        ),
        [worker]: report,
      },
    }))
  }

  const clearRequested = async () => {
    const requests = clearsSchema.safeParse(await kv.get(CLEARS_KEY)).data?.requests ?? []
    const due = requests.filter((request) => !handled.has(request.id) && request.at >= startedAt)
    if (!due.length) return
    const reports = await workerStorageReports(kv, { now: now(), staleMs: 3 * intervalMs })
    const mine = reports.find((report) => report.worker === worker)
    for (const request of due) {
      handled.add(request.id)
      const provider = providers.find((entry) => entry.id === request.provider)
      if (!provider?.clear) continue
      const volume = mine?.providers.find((entry) => entry.id === provider.id)?.volume
      // A shared volume is cleared by one of the workers on it, the first by name.
      if (volume && (sharing(reports, provider.id, volume)[0] ?? worker) !== worker) continue
      try {
        const result = await provider.clear(request.scope)
        log(`storage: cleared ${provider.id} on ${worker}: ${JSON.stringify(result)}`)
      } catch (error) {
        log(`storage: clearing ${provider.id} on ${worker} failed: ${message(error)}`)
      }
    }
    await publish()
  }

  const serially = (work: () => Promise<void>, what: string) => () => {
    running = running.then(work).catch((error: unknown) => {
      log(`storage: ${what} failed: ${message(error)}`)
    })
  }
  const tick = serially(publish, 'publishing usage')
  const poll = serially(clearRequested, 'reading clear requests')
  tick()
  const reportTimer = setInterval(tick, intervalMs)
  const pollTimer = setInterval(poll, options.pollMs ?? 15_000)
  return async () => {
    clearInterval(reportTimer)
    clearInterval(pollTimer)
    await running
    await update(kv, REPORTS_KEY, reportsSchema, (current) => ({
      reports: Object.fromEntries(
        Object.entries(current?.reports ?? {}).filter(([name]) => name !== worker),
      ),
    })).catch((error: unknown) => log(`storage: dropping the report failed: ${message(error)}`))
  }
}

/** Reports of workers that published within `staleMs` (default 15 minutes), by worker name. */
export async function workerStorageReports(
  kv: Pick<KvStore, 'get'>,
  options: { staleMs?: number; now?: Date } = {},
): Promise<WorkerStorageReport[]> {
  const staleBefore = (options.now ?? new Date()).getTime() - (options.staleMs ?? 900_000)
  const reports = reportsSchema.safeParse(await kv.get(REPORTS_KEY)).data?.reports ?? {}
  return Object.values(reports)
    .filter((report) => Date.parse(report.at) >= staleBefore)
    .toSorted((a, b) => a.worker.localeCompare(b.worker))
}

/**
 * One view per provider id across worker reports. Each volume counts once: workers that report
 * the same volume id share one detail line (`shared: a, b`) with the newest measurement, others
 * get one line each; bytes and counts add up over those lines. Clearable when any worker can.
 */
export function reportedViews(reports: readonly WorkerStorageReport[]): StorageProviderView[] {
  type Entry = WorkerStorageReport['providers'][number] & { worker: string; at: string }
  const byId = new Map<string, Entry[]>()
  for (const report of reports)
    for (const provider of report.providers)
      byId.set(provider.id, [
        ...(byId.get(provider.id) ?? []),
        { ...provider, worker: report.worker, at: report.at },
      ])
  return [...byId].map(([id, entries]) => {
    const volumes = new Map<string, Entry[]>()
    for (const entry of entries) {
      const key = entry.volume ?? `worker:${entry.worker}`
      volumes.set(key, [...(volumes.get(key) ?? []), entry])
    }
    const lines = [...volumes.values()].map((group) => {
      const newest = group.toSorted((a, b) => b.at.localeCompare(a.at)).find((e) => e.usage)
      const workers = group.map((entry) => entry.worker).toSorted()
      return {
        label: workers.length > 1 ? `shared: ${workers.join(', ')}` : (workers[0] ?? '?'),
        usage: newest?.usage,
      }
    })
    const measured = lines.filter((line) => line.usage && line.usage.available !== false)
    const details: StorageDetailView[] = measured
      .map((line) => ({
        label: line.label,
        bytes: line.usage?.bytes ?? 0,
        ...(line.usage?.count !== undefined ? { count: line.usage.count } : {}),
      }))
      .toSorted((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label))
    const counts = measured.flatMap((line) =>
      line.usage?.count !== undefined ? [line.usage.count] : [],
    )
    const errors = entries.flatMap((entry) =>
      entry.error ? [`${entry.worker}: ${entry.error}`] : [],
    )
    const workers = entries.length
    const shared = lines.length < workers
    return {
      id,
      label: entries[0]?.label ?? id,
      bytes: details.reduce((sum, detail) => sum + detail.bytes, 0),
      ...(counts.length ? { count: counts.reduce((sum, count) => sum + count, 0) } : {}),
      details,
      available: measured.length > 0,
      note: `Reported by ${workers} ${workers === 1 ? 'worker' : 'workers'}${shared ? `, ${lines.length} ${lines.length === 1 ? 'volume' : 'volumes'}` : ''}`,
      clearable: entries.some((entry) => entry.clearable),
      reportedBy: workers,
      ...(errors.length ? { error: errors.join('; ') } : {}),
    }
  })
}

/**
 * Asks every worker to clear `provider` (with `scope`); workers that started before the request
 * carry it out within their poll interval. Resolves with how many fresh workers report it.
 */
export async function requestStorageClear(
  kv: Kv,
  provider: string,
  scope: string | undefined,
  options: { now?: Date } = {},
): Promise<number> {
  const at = options.now ?? new Date()
  await update(kv, CLEARS_KEY, clearsSchema, (current) => ({
    requests: [
      ...(current?.requests ?? []).filter(
        (request) => at.getTime() - Date.parse(request.at) < KEEP_CLEARS_MS,
      ),
      {
        id: crypto.randomUUID(),
        provider,
        ...(scope !== undefined ? { scope } : {}),
        at: at.toISOString(),
      },
    ],
  }))
  const reports = await workerStorageReports(kv, { now: at })
  return reports.filter((report) => report.providers.some((entry) => entry.id === provider)).length
}
