import type { AnalyzerArtifact, AnyAnalyzer } from '@holtkeeper/analyzer'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisRecord, AnalysisStore, ClaimRules, Job, JobStore } from '@holtkeeper/store'

import type { ContextFor } from './context.ts'

export interface WorkerOptions {
  store: { jobs: JobStore; analyses: AnalysisStore }
  analyzers: AnyAnalyzer[]
  contextFor: ContextFor
  /**
   * The scoped setting `analyzers.<kind>` resolved for the job's repository: a partial options
   * object. Options are merged shallowly, later wins: the job's options for scheduled, tag and
   * webhook jobs (schedule options), this setting, then the job's options for manual jobs; the
   * analyzer's schema adds defaults and validates the result.
   */
  settingOptions?: (job: Job, analyzer: AnyAnalyzer) => Promise<Record<string, unknown> | undefined>
  /** Jobs run at the same time. Default 2. */
  concurrency?: number
  /** A run is aborted after this long. Default 30 minutes. */
  timeoutMs?: number
  now?: () => Date
  /** Default: a random id. */
  workerId?: string
  /** How often an idle worker looks for due jobs. Default 5 seconds. */
  pollMs?: number
  /** Default 15 seconds. */
  heartbeatMs?: number
  /**
   * Running jobs without a heartbeat for this long are recovered on `start` and then every
   * `staleMs`, so a job whose worker died (killed for memory, a lost node) runs again even when
   * that worker restarted before the job went stale. Default 2 minutes.
   */
  staleMs?: number
  /** Delay before retry number `attempt` (1-based). Default: 1 minute, doubling, at most 1 hour. */
  retryDelayMs?: (attempt: number) => number
  /**
   * Stores the binary artifacts a run returned, after its record is stored; `analysisId` is the
   * record's id. A failing hook is logged and does not fail the job. Without it artifacts are dropped.
   */
  persistArtifacts?: PersistArtifacts
  /** Called once per job that succeeded (with its record) or failed for good (without one). */
  onFinished?: (job: Job, record?: AnalysisRecord) => void | Promise<void>
  /**
   * Whether a claimed job may start now, e.g. `false` while the credentials it needs are
   * saturated. A refused job stays claimed (heartbeat running, attempt not repeated) without
   * taking a concurrency slot, and is asked again every `admissionPollMs` while the worker claims
   * other jobs. A hook that throws admits the job. Default: every job is admitted.
   */
  admission?: (job: Job) => boolean | Promise<boolean>
  /** Default 1 second. */
  admissionPollMs?: number
  /**
   * Claimed jobs waiting for admission at most; the worker stops claiming beyond. Default twice
   * `concurrency`, at least 4.
   */
  maxWaiting?: number
  /**
   * Claims at most this many jobs, then stops claiming; `Worker.exhausted` resolves once they all
   * ended. For one-job-per-process isolation. Default: no limit.
   */
  maxJobs?: number
  log?: (line: string) => void
}

/** Stores a run's artifacts, tagged with the analysis that refers to them. */
export type PersistArtifacts = (
  artifacts: AnalyzerArtifact[],
  context: { repo: RepoRef; kind: string; analysisId: string },
) => Promise<void>

/** Claims queued jobs and runs their analyzers. */
export interface Worker {
  /** Recovers jobs of dead workers, then keeps claiming jobs until `stop`. */
  start(): Promise<void>
  /** Stops claiming, aborts running jobs (they go back to the queue) and waits for them. */
  stop(): Promise<void>
  /** Claims one due job and runs it to the end; `undefined` when nothing was due. */
  runNext(): Promise<Job | undefined>
  /**
   * Stops claiming and lets running jobs finish for up to `timeoutMs`; jobs still running then,
   * and claimed jobs waiting for admission, are aborted and go back to the queue.
   */
  drain(timeoutMs: number): Promise<{ finished: number; requeued: number }>
  /** Jobs claimed and not ended yet. */
  readonly running: number
  /** Resolves once `maxJobs` jobs were claimed and all of them ended; pending without `maxJobs`. */
  readonly exhausted: Promise<void>
}

/** A failure that retrying cannot fix, e.g. an unknown analyzer or invalid options. */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError'
}

class JobAbort extends Error {
  override name = 'JobAbort'
  readonly reason: 'timeout' | 'canceled' | 'stopped'

  constructor(reason: 'timeout' | 'canceled' | 'stopped', message: string) {
    super(message)
    this.reason = reason
  }
}

export const exponentialBackoff = (attempt: number) =>
  Math.min(60_000 * 2 ** Math.max(attempt - 1, 0), 3_600_000)

/** A claimed job's place in the worker: `held` once it occupies a concurrency slot. */
interface Ticket {
  held: boolean
  refill: boolean
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Settles with `promise`, or rejects with the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Creates a worker. Nothing runs until `start` or `runNext`. */
export function createWorker(options: WorkerOptions): Worker {
  const { store, contextFor } = options
  const analyzers = new Map(options.analyzers.map((analyzer) => [analyzer.kind, analyzer]))
  const rules: ClaimRules = {
    exclusive: options.analyzers.filter((analyzer) => analyzer.exclusive).map((a) => a.kind),
    after: Object.fromEntries(
      options.analyzers.flatMap((analyzer) =>
        analyzer.after ? [[analyzer.kind, analyzer.after]] : [],
      ),
    ),
  }
  const now = options.now ?? (() => new Date())
  const at = () => now().toISOString()
  const workerId = options.workerId ?? `worker-${crypto.randomUUID().slice(0, 8)}`
  const concurrency = options.concurrency ?? 2
  const timeoutMs = options.timeoutMs ?? 30 * 60_000
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const staleMs = options.staleMs ?? 120_000
  const retryDelayMs = options.retryDelayMs ?? exponentialBackoff
  const say = options.log ?? (() => {})
  const admission = options.admission
  const admissionPollMs = options.admissionPollMs ?? 1000
  const maxWaiting = admission
    ? Math.max(1, options.maxWaiting ?? Math.max(4, 2 * concurrency))
    : Infinity

  const maxJobs = options.maxJobs ?? Infinity
  const active = new Set<Promise<Job | undefined>>()
  const controllers = new Map<AbortController, Ticket>()
  const exhausted = Promise.withResolvers<void>()
  let claimed = 0
  let admitted = 0
  let waiting = 0
  let stopped = false
  let filling = false
  let poll: ReturnType<typeof setInterval> | undefined
  let sweep: ReturnType<typeof setInterval> | undefined

  const finished = async (job: Job, record?: AnalysisRecord) => {
    try {
      await options.onFinished?.(job, record)
    } catch (error) {
      say(`onFinished failed for job ${job.id}: ${messageOf(error)}`)
    }
  }

  const admit = async (job: Job) => {
    if (!admission) return true
    try {
      return await admission(job)
    } catch (error) {
      say(`admission check failed for job ${job.id}: ${messageOf(error)}`)
      return true
    }
  }

  /** Claimed jobs waiting for a slot, in the order they were claimed. */
  const queue: { job: Job; ticket: Ticket }[] = []
  let pumping: Promise<void> | undefined

  /**
   * Hands free slots to waiting jobs, oldest claim first. A job the admission hook refuses
   * (its forge or AI credential is busy) is passed over for younger ones, so one saturated
   * credential does not block the rest, but it never loses a free slot to a younger job that
   * merely asked first.
   */
  function pump(): Promise<void> {
    pumping ??= drain().finally(() => {
      pumping = undefined
    })
    return pumping
  }

  async function drain() {
    for (const entry of queue.slice()) {
      if (admitted >= concurrency) return
      // oxlint-disable-next-line no-await-in-loop -- strictly oldest first
      if (!(await admit(entry.job)) || admitted >= concurrency) continue
      const index = queue.indexOf(entry)
      if (index === -1) continue
      queue.splice(index, 1)
      waiting--
      admitted++
      entry.ticket.held = true
      if (entry.ticket.refill) void fill()
    }
  }

  /** Resolves once the job holds a concurrency slot. */
  async function waitForAdmission(
    job: Job,
    ticket: Ticket,
    signal: AbortSignal,
    log: (line: string) => void,
  ) {
    const entry = { job, ticket }
    queue.push(entry)
    let told = false
    try {
      for (;;) {
        await abortable(pump(), signal)
        if (ticket.held) return
        if (!told) {
          log('waiting for capacity')
          told = true
        }
        await sleep(admissionPollMs, signal)
      }
    } finally {
      const index = queue.indexOf(entry)
      if (index !== -1) queue.splice(index, 1)
    }
  }

  async function execute(job: Job, ticket: Ticket): Promise<Job | undefined> {
    const label = `${job.analyzer} ${job.repo.forge}:${job.repo.path}${job.ref ? `@${job.ref}` : ''}`
    const controller = new AbortController()
    controllers.set(controller, ticket)
    const { signal } = controller
    let pendingLog: Promise<void> = Promise.resolve()
    const log = (line: string) => {
      pendingLog = pendingLog.then(() => store.jobs.appendLog(job.id, [line])).catch(() => {})
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const beat = async () => {
      const alive = await store.jobs.heartbeat(job.id, workerId, at()).catch(() => true)
      if (!alive) controller.abort(new JobAbort('canceled', 'job was canceled'))
    }
    const heartbeat = setInterval(() => void beat(), heartbeatMs)

    try {
      if (!ticket.held) await waitForAdmission(job, ticket, signal, log)
      timeout = setTimeout(
        () =>
          controller.abort(
            new JobAbort('timeout', `timed out after ${Math.round(timeoutMs / 1000)}s`),
          ),
        timeoutMs,
      )
      log(`attempt ${job.attempts} of ${job.maxAttempts} on ${workerId}`)
      const analyzer = analyzers.get(job.analyzer)
      if (!analyzer) throw new PermanentJobError(`unknown analyzer "${job.analyzer}"`)
      const scoped = (await options.settingOptions?.(job, analyzer)) ?? {}
      const merged =
        job.trigger === 'manual' ? { ...scoped, ...job.options } : { ...job.options, ...scoped }
      const parsed = analyzer.options.safeParse(merged)
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`.trim())
        throw new PermanentJobError(`invalid options for ${analyzer.kind}: ${issues.join('; ')}`)
      }

      const prepared = await abortable(
        contextFor(job, analyzer, { signal, log, options: parsed.data }),
        signal,
      )
      let result: { data: unknown; ref?: string; at?: string; artifacts?: AnalyzerArtifact[] }
      try {
        result = await abortable(
          analyzer.run({ ...prepared.context, options: parsed.data, signal, log }),
          signal,
        )
      } finally {
        await prepared.cleanup()
      }
      if (signal.aborted) throw signal.reason

      const ref = result.ref ?? job.ref
      const record = await store.analyses.add({
        repo: job.repo,
        kind: analyzer.analysis.kind,
        ...(ref !== undefined && { ref }),
        createdAt: result.at ?? at(),
        ...(job.actor !== undefined && { actor: job.actor }),
        data: result.data,
      })
      log(`stored analysis ${record.id}`)
      if (result.artifacts?.length && options.persistArtifacts) {
        try {
          await options.persistArtifacts(result.artifacts, {
            repo: job.repo,
            kind: record.kind,
            analysisId: record.id,
          })
          log(`stored ${result.artifacts.length} artifact(s)`)
        } catch (error) {
          log(`storing artifacts failed: ${messageOf(error)}`)
        }
      }
      await pendingLog
      const done = await store.jobs.complete(job.id, { at: at(), analysisId: record.id })
      say(`job ${job.id} (${label}) succeeded`)
      if (done) await finished(done, record)
      return done ?? (await store.jobs.get(job.id))
    } catch (error) {
      const abort = error instanceof JobAbort ? error : undefined
      if (abort?.reason === 'canceled') {
        log('canceled')
        await pendingLog
        say(`job ${job.id} (${label}) canceled`)
        return store.jobs.get(job.id)
      }
      const message = messageOf(error)
      log(`failed: ${message}`)
      await pendingLog
      const retryAt =
        error instanceof PermanentJobError
          ? undefined
          : abort?.reason === 'stopped'
            ? at()
            : new Date(now().getTime() + retryDelayMs(job.attempts)).toISOString()
      const failed = await store.jobs.fail(job.id, {
        at: at(),
        error: message,
        ...(retryAt !== undefined && { retryAt }),
      })
      say(
        `job ${job.id} (${label}) ${failed?.status === 'queued' ? 'will retry' : 'failed'}: ${message}`,
      )
      if (failed?.status === 'failed') await finished(failed)
      return failed
    } finally {
      clearTimeout(timeout)
      clearInterval(heartbeat)
      controllers.delete(controller)
    }
  }

  const claim = async () => {
    if (claimed >= maxJobs) return undefined
    const job = await store.jobs.claim(workerId, at(), rules)
    if (job) claimed++
    return job
  }

  const track = (job: Job, refill: boolean) => {
    const ticket: Ticket = { held: !admission, refill }
    if (ticket.held) admitted++
    else waiting++
    const run = execute(job, ticket).finally(() => {
      if (ticket.held) {
        admitted--
        if (queue.length) void pump()
      } else waiting--
      active.delete(run)
      if (claimed >= maxJobs && active.size === 0) exhausted.resolve()
      if (refill) void fill()
    })
    active.add(run)
    return run
  }

  async function recover() {
    const recovered = await store.jobs.recoverStale(
      new Date(now().getTime() - staleMs).toISOString(),
      at(),
    )
    for (const job of recovered) say(`recovered job ${job.id} (${job.status})`)
  }

  const sweepStale = () =>
    recover().then(fill, (error: unknown) =>
      say(`recovering stale jobs failed: ${messageOf(error)}`),
    )

  async function fill() {
    if (filling || stopped) return
    filling = true
    try {
      const claimNext = async (): Promise<void> => {
        if (stopped || admitted >= concurrency || waiting >= maxWaiting) return
        const job = await claim()
        if (!job) return
        void track(job, true)
        await claimNext()
      }
      await claimNext()
    } catch (error) {
      say(`claiming jobs failed: ${messageOf(error)}`)
    } finally {
      filling = false
    }
  }

  return {
    async start() {
      stopped = false
      await recover()
      poll ??= setInterval(() => void fill(), options.pollMs ?? 5_000)
      sweep ??= setInterval(() => void sweepStale(), staleMs)
      await fill()
    },
    async stop() {
      stopped = true
      clearInterval(poll)
      clearInterval(sweep)
      poll = undefined
      sweep = undefined
      for (const controller of controllers.keys())
        controller.abort(new JobAbort('stopped', 'worker stopped'))
      await Promise.allSettled(active)
    },
    async runNext() {
      const job = await claim()
      return job ? track(job, false) : undefined
    },
    async drain(limitMs) {
      stopped = true
      clearInterval(poll)
      poll = undefined
      let requeued = 0
      const abort = (which: (ticket: Ticket) => boolean) => {
        for (const [controller, ticket] of controllers) {
          if (!which(ticket) || controller.signal.aborted) continue
          controller.abort(new JobAbort('stopped', 'worker is draining'))
          requeued++
        }
      }
      abort((ticket) => !ticket.held)
      const total = active.size
      const all = Promise.allSettled(active)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        all.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), limitMs)
        }),
      ])
      clearTimeout(timer)
      if (timedOut) abort(() => true)
      await all
      return { finished: total - requeued, requeued }
    },
    get running() {
      return active.size
    },
    exhausted: exhausted.promise,
  }
}
