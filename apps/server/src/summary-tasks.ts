import type { ReleaseCompareSummary, ReleaseCompareSummaryState } from '@holtkeeper/api'
import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

/** How long a running marker counts after its last heartbeat before its run is taken for dead. */
const SUMMARY_RUNNING_SECONDS = 15 * 60
/** How often a run renews its marker. */
const SUMMARY_BEAT_SECONDS = 5 * 60
/** How long a failure is shown before the task reads as never run. */
const SUMMARY_FAILED_SECONDS = 10 * 60

const taskSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('running'),
    startedAt: z.string(),
    beatAt: z.string().optional(),
    runId: z.string(),
  }),
  z.object({
    status: z.literal('done'),
    markdown: z.string(),
    code: z.boolean(),
    cached: z.boolean(),
  }),
  z.object({ status: z.literal('failed'), error: z.string() }),
])

/** What a summary run hands back: the description and how long to keep it. */
interface SummaryTaskResult {
  summary: ReleaseCompareSummary
  keepSeconds: number
}

/** Background AI descriptions tracked in a `KvStore`, one task per key. */
export interface SummaryTasks {
  /**
   * Where the task of `key` stands; a running marker not renewed for `SUMMARY_RUNNING_SECONDS`
   * reads as `none`.
   */
  read(key: string): Promise<ReleaseCompareSummaryState>
  /**
   * Starts `run` in the background unless the task of `key` is running or done, whose state is
   * answered instead. Within one process a start always joins a run in flight; across processes
   * sharing the store only one start wins when the store has `compareAndSet`. A run renews its
   * marker while it lasts and writes its outcome only while the marker is still its own. The
   * result is kept for its `keepSeconds`, a failed run for `SUMMARY_FAILED_SECONDS`; when only
   * storing the result fails, the marker is dropped instead of recording a failure.
   */
  start(key: string, run: () => Promise<SummaryTaskResult>): Promise<ReleaseCompareSummaryState>
}

interface InFlight {
  startedAt: string
  beatAt: string
  outcome: Promise<ReleaseCompareSummaryState>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * `SummaryTasks` over `kv`, with `now` as the clock and `onBackground` receiving each run.
 */
export function summaryTasks(deps: {
  kv: Pick<KvStore, 'get' | 'set'> & Partial<Pick<KvStore, 'compareAndSet' | 'delete'>>
  now: () => Date
  onBackground?: (work: Promise<unknown>) => void
}): SummaryTasks {
  const { kv, now } = deps
  const inFlight = new Map<string, InFlight>()
  const alive = (entry: InFlight | undefined): entry is InFlight =>
    entry !== undefined &&
    now().getTime() - Date.parse(entry.beatAt) <= SUMMARY_RUNNING_SECONDS * 1000

  const stateOf = (raw: unknown): ReleaseCompareSummaryState => {
    const task = taskSchema.safeParse(raw).data
    if (!task) return { status: 'none' }
    if (task.status === 'running') {
      const age = now().getTime() - Date.parse(task.beatAt ?? task.startedAt)
      return age > SUMMARY_RUNNING_SECONDS * 1000
        ? { status: 'none' }
        : { status: 'running', startedAt: task.startedAt }
    }
    if (task.status === 'failed') return { status: 'failed', error: task.error }
    return { status: 'done', markdown: task.markdown, code: task.code, cached: task.cached }
  }

  const read = async (key: string): Promise<ReleaseCompareSummaryState> => {
    const local = inFlight.get(key)
    if (alive(local)) return { status: 'running', startedAt: local.startedAt }
    return stateOf(await kv.get(key).catch(() => undefined))
  }

  const execute = (
    key: string,
    marker: object,
    run: () => Promise<SummaryTaskResult>,
    onBeat: (at: string) => void,
  ) => {
    let current: object = marker
    const replace = async (value: object, ttlSeconds: number) => {
      if (kv.compareAndSet) return kv.compareAndSet(key, current, value, ttlSeconds)
      await kv.set(key, value, ttlSeconds)
      return true
    }
    let beating = Promise.resolve()
    const beat = async () => {
      const beatAt = now().toISOString()
      const next = { ...current, beatAt }
      if (await replace(next, SUMMARY_RUNNING_SECONDS).catch(() => false)) {
        current = next
        onBeat(beatAt)
      }
    }
    const timer = setInterval(() => {
      beating = beating.then(beat)
    }, SUMMARY_BEAT_SECONDS * 1000)
    timer.unref?.()
    return (async (): Promise<ReleaseCompareSummaryState> => {
      let result: SummaryTaskResult
      try {
        result = await run()
      } catch (error) {
        clearInterval(timer)
        await beating
        const failed = { status: 'failed' as const, error: messageOf(error) }
        await replace(failed, SUMMARY_FAILED_SECONDS).catch(() => false)
        return failed
      }
      clearInterval(timer)
      await beating
      const done = { status: 'done' as const, ...result.summary }
      const persist = async (attempts: number): Promise<boolean> => {
        try {
          await replace(done, result.keepSeconds)
          return true
        } catch {
          return attempts > 1 ? persist(attempts - 1) : false
        }
      }
      if (!(await persist(2))) await kv.delete?.(key).catch(() => {})
      return done
    })()
  }

  const start = async (
    key: string,
    run: () => Promise<SummaryTaskResult>,
  ): Promise<ReleaseCompareSummaryState> => {
    const local = inFlight.get(key)
    if (alive(local)) return { status: 'running', startedAt: local.startedAt }
    const raw = await kv.get(key).catch(() => undefined)
    const current = stateOf(raw)
    if (current.status === 'running' || current.status === 'done') return current
    if (alive(inFlight.get(key))) return read(key)
    const startedAt = now().toISOString()
    const marker = { status: 'running', startedAt, runId: crypto.randomUUID() }
    const claim = (async () => {
      if (kv.compareAndSet) return kv.compareAndSet(key, raw, marker, SUMMARY_RUNNING_SECONDS)
      await kv.set(key, marker, SUMMARY_RUNNING_SECONDS)
      return true
    })()
    const stored = async () => stateOf(await kv.get(key).catch(() => undefined))
    const entry: InFlight = {
      startedAt,
      beatAt: startedAt,
      outcome: claim
        .then(
          (won) =>
            won
              ? execute(key, marker, run, (at) => {
                  entry.beatAt = at
                })
              : stored(),
          (error: unknown): ReleaseCompareSummaryState => ({
            status: 'failed',
            error: messageOf(error),
          }),
        )
        .finally(() => {
          if (inFlight.get(key) === entry) inFlight.delete(key)
        }),
    }
    inFlight.set(key, entry)
    const forget = () => {
      if (inFlight.get(key) === entry) inFlight.delete(key)
    }
    const won = await claim.catch((error: unknown) => {
      forget()
      throw error
    })
    if (!won) {
      forget()
      return stored()
    }
    deps.onBackground?.(entry.outcome)
    return { status: 'running', startedAt }
  }

  return { read, start }
}
