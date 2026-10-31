import type { LibraryIndexProgressView, LibrarySourceCoverage } from '@holtkeeper/api'
import type { LibraryIndexProgress } from '@holtkeeper/libraries'
import type { KvStore, LibraryRecord, LibraryVersionRecord } from '@holtkeeper/store'
import { z } from 'zod'

const PROGRESS_KEY = 'libraries:progress'
const PROGRESS_TTL_S = 900

const progressSchema = z.object({
  startedAt: z.string(),
  total: z.number(),
  done: z.number(),
  library: z.string().optional(),
  waitingUntil: z.string().optional(),
  updatedAt: z.string(),
})

/** The run going on now as the leader last wrote it; `undefined` when none is. */
export async function libraryProgress(
  kv: Pick<KvStore, 'get'> | undefined,
): Promise<LibraryIndexProgressView | undefined> {
  const parsed = progressSchema.safeParse(await kv?.get(PROGRESS_KEY))
  if (!parsed.success) return undefined
  const { library, waitingUntil, ...rest } = parsed.data
  return { ...rest, ...(library ? { library } : {}), ...(waitingUntil ? { waitingUntil } : {}) }
}

/** Writes how far one run is, for every process to read; see `libraryProgressWriter`. */
export interface LibraryProgressWriter {
  update(progress: LibraryIndexProgress): void
  /** Every GitHub token is used up until `until`. */
  waiting(until: Date): void
  /** Removes the progress; the run is over. */
  clear(): Promise<void>
}

/**
 * Keeps `libraries:progress` in `kv` current for one run: written at most every `intervalMs`
 * (default 3 s) and on waits, with a 15 minute expiry renewed on every write, so a process that
 * dies mid-run leaves no progress behind for long.
 */
export function libraryProgressWriter(options: {
  kv: Pick<KvStore, 'set' | 'delete'> | undefined
  now: () => Date
  intervalMs?: number
}): LibraryProgressWriter {
  const intervalMs = options.intervalMs ?? 3_000
  const startedAt = options.now().toISOString()
  let state: LibraryIndexProgress = { total: 0, done: 0 }
  let waitingUntil: string | undefined
  let writtenAt = 0
  const write = (force: boolean) => {
    const at = options.now()
    if (!options.kv || (!force && at.getTime() - writtenAt < intervalMs)) return
    writtenAt = at.getTime()
    const view: LibraryIndexProgressView = {
      startedAt,
      total: state.total,
      done: state.done,
      ...(state.library ? { library: state.library } : {}),
      ...(waitingUntil && Date.parse(waitingUntil) > at.getTime() ? { waitingUntil } : {}),
      updatedAt: at.toISOString(),
    }
    void options.kv.set(PROGRESS_KEY, view, PROGRESS_TTL_S).catch(() => {})
  }
  return {
    update(progress) {
      state = progress
      write(progress.done === 0 || progress.done === progress.total)
    },
    waiting(until) {
      waitingUntil = until.toISOString()
      write(true)
    },
    async clear() {
      await options.kv?.delete(PROGRESS_KEY).catch(() => {})
    },
  }
}

const VERSION_SOURCES = ['archive', 'api', 'repository', 'releases'] as const
const LIBRARY_SOURCES = ['issues', 'site'] as const

const emptyCoverage = (source: string): LibrarySourceCoverage => ({
  source,
  ok: 0,
  missing: 0,
  failed: 0,
  skipped: 0,
  pending: 0,
})

/**
 * Per source, how many versions in the matrix (libraries for `issues` and `site`) are `ok`,
 * `missing`, `failed`, `skipped` or not fetched yet (`pending`). `site` is listed only when some
 * library has it, since it is off by default.
 */
export function librarySourceCoverage(
  entries: readonly { library: LibraryRecord; versions: readonly LibraryVersionRecord[] }[],
): LibrarySourceCoverage[] {
  const coverage = new Map<string, LibrarySourceCoverage>()
  const count = (source: string, status: string | undefined) => {
    let row = coverage.get(source)
    if (!row) coverage.set(source, (row = emptyCoverage(source)))
    if (status === 'ok' || status === 'missing' || status === 'failed' || status === 'skipped')
      row[status] += 1
    else row.pending += 1
  }
  for (const { library, versions } of entries) {
    for (const version of versions)
      if (version.roles.length)
        for (const source of VERSION_SOURCES) count(source, version.sources[source]?.status)
    for (const source of LIBRARY_SOURCES)
      if (source !== 'site' || library.sources.site) count(source, library.sources[source]?.status)
  }
  return [...VERSION_SOURCES, ...LIBRARY_SOURCES].flatMap((source) => {
    const row = coverage.get(source)
    return row ? [row] : []
  })
}
