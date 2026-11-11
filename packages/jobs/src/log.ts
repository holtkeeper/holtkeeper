import { type ArtifactStore, isRefName } from '@holtkeeper/artifacts'

/** One line of a job attempt's log. */
export interface JobLogLine {
  /** 0-based position in the attempt's log. */
  n: number
  at: string
  text: string
  level?: 'error'
  /** The innermost step running when the line was written. */
  step?: string
  /** Set on the lines `JobLog.step` writes when a step starts, ends or fails. */
  mark?: 'start' | 'end' | 'fail'
  /** Duration of the step, on `end` and `fail` marks. */
  ms?: number
}

/** The log of one job attempt as the worker writes it. Nothing it does throws. */
export interface JobLog {
  write(text: string, fields?: Pick<JobLogLine, 'level'>): void
  /**
   * Runs `run` as the step `name`: writes a start mark, tags the lines written meanwhile with the
   * step, and writes an end mark with the duration, or a fail mark when `run` throws (the error
   * is rethrown).
   */
  step<T>(name: string, run: () => Promise<T>): Promise<T>
  /** The innermost step whose error ended the run so far, if any failed. */
  readonly failedStep: string | undefined
  /** Stores the lines written so far. */
  flush(): Promise<void>
  /** Stores the rest and marks the log complete; later writes are dropped. */
  close(): Promise<void>
}

export interface JobLogOptions {
  jobId: string
  /** 1-based attempt number. */
  attempt: number
  /** Lines buffered before a chunk is stored. Default 100. */
  flushLines?: number
  /** A buffered line is stored at most this long after it was written. Default 1 second. */
  flushMs?: number
  /** Lines kept per attempt; one notice replaces the rest. Default 50,000. */
  maxLines?: number
  now?: () => Date
  /** Called when storing a chunk fails; its lines are kept for the next flush. */
  onError?: (error: unknown) => void
}

/** One step of an attempt, folded from its `start` mark and its `end` or `fail` mark. */
export interface JobStep {
  name: string
  /** 0 for a top-level step, 1 for a step inside it, and so on. */
  depth: number
  /** `n` of the step's start mark. */
  line: number
  startedAt: string
  /** `running` until its end or fail mark was stored. */
  status: 'running' | 'succeeded' | 'failed'
  /** Duration, once the step ended. */
  ms?: number
}

/** One page of an attempt's log, as `readJobLog` returns it. */
export interface JobLogPage {
  /** Lines in the attempt's log so far. */
  total: number
  /** `n` of the first line returned. */
  offset: number
  lines: JobLogLine[]
  /** The worker closed the log: no more lines will follow. */
  complete: boolean
  /** Every step of the attempt stored so far, in start order, whatever page was read. */
  steps: JobStep[]
}

export interface ReadJobLogOptions {
  /** First line to return. Default 0. */
  offset?: number
  /** Lines returned at most. Default 500, at most `MAX_LOG_PAGE`. */
  limit?: number
  /** Returns the last `tail` lines instead of reading from `offset`. */
  tail?: number
}

/** The largest page `readJobLog` returns. */
export const MAX_LOG_PAGE = 2000

const CLOSE_TRIES = 3

/** Step marks the head ref keeps; deeper logs fold only their first steps. */
const MAX_MARKS = 400

type Mark = Pick<JobLogLine, 'n' | 'at' | 'mark' | 'step' | 'ms'>

/**
 * The steps that `start`, `end` and `fail` marks describe, in start order. A mark without its
 * start (cut off by a cap) is ignored; a step without an end is `running`.
 */
export function stepsOf(marks: readonly Mark[]): JobStep[] {
  const steps: JobStep[] = []
  const open: JobStep[] = []
  for (const mark of marks) {
    if (!mark.mark || mark.step === undefined) continue
    if (mark.mark === 'start') {
      const step: JobStep = {
        name: mark.step,
        depth: open.length,
        line: mark.n,
        startedAt: mark.at,
        status: 'running',
      }
      steps.push(step)
      open.push(step)
      continue
    }
    const index = open.findLastIndex((step) => step.name === mark.step)
    if (index < 0) continue
    const [step] = open.splice(index)
    if (!step) continue
    step.status = mark.mark === 'end' ? 'succeeded' : 'failed'
    if (mark.ms !== undefined) step.ms = mark.ms
  }
  return steps
}

const isMark = (value: unknown): value is Mark =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'n') === 'number' &&
  typeof Reflect.get(value, 'at') === 'string'

const parseMarks = (meta: Record<string, unknown> | undefined): Mark[] => {
  const raw = meta?.marks
  if (typeof raw !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isMark) : []
  } catch {
    return []
  }
}

const prefix = (jobId: string, attempt: number) => `job-logs/${jobId}/${attempt}`

const toBytes = (lines: readonly JobLogLine[]) =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join('\n'))

const isLogLine = (value: unknown): value is JobLogLine =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'n') === 'number' &&
  typeof Reflect.get(value, 'text') === 'string'

const parseChunk = (data: Uint8Array): JobLogLine[] =>
  new TextDecoder()
    .decode(data)
    .split('\n')
    .flatMap((line) => {
      const parsed: unknown = line ? JSON.parse(line) : undefined
      return isLogLine(parsed) ? [parsed] : []
    })

const metaNumber = (meta: Record<string, unknown> | undefined, key: string) => {
  const value = meta?.[key]
  return typeof value === 'number' ? value : 0
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A `JobLog` that stores the attempt's log in `store` as chunks of JSON lines: a chunk is stored
 * every `flushLines` lines or `flushMs` after the first buffered line, on `flush` and on
 * `close`. Each chunk is an artifact behind the ref `job-logs/<job>/<attempt>/<index>`; the ref
 * `job-logs/<job>/<attempt>/head` counts chunks and lines. `readJobLog` reads them back.
 */
export function createJobLog(store: ArtifactStore, options: JobLogOptions): JobLog {
  const now = options.now ?? (() => new Date())
  const flushLines = options.flushLines ?? 100
  const flushMs = options.flushMs ?? 1000
  const maxLines = options.maxLines ?? 50_000
  const base = prefix(options.jobId, options.attempt)
  const usable = isRefName(`${base}/head`)
  const steps: string[] = []
  const marks: Mark[] = []
  let buffer: JobLogLine[] = []
  let unstored: JobLogLine[] = []
  let lines = 0
  let chunks = 0
  let truncated = false
  let closed = false
  let failure: { step: string; error: unknown } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()

  const storeChunk = async (taken: JobLogLine[], complete: boolean): Promise<boolean> => {
    if (!usable) return true
    const chunk = [...unstored, ...taken]
    unstored = []
    if (!chunk.length && !complete) return true
    try {
      let id: string | undefined
      if (chunk.length) {
        const first = chunk[0]?.n ?? 0
        const stored = await store.put(toBytes(chunk), {
          contentType: 'application/x-ndjson',
          tags: { kind: 'job-log', job: options.jobId },
        })
        id = stored.id
        await store.setRef(`${base}/${chunks}`, {
          id,
          meta: { first, count: chunk.length },
        })
        chunks++
      } else {
        id = (await store.getRef(`${base}/head`))?.id
      }
      const stored = (chunk.at(-1)?.n ?? lines - 1) + 1
      if (id)
        await store.setRef(`${base}/head`, {
          id,
          meta: {
            chunks,
            lines: stored,
            complete,
            marks: JSON.stringify(marks.filter((mark) => mark.n < stored)),
          },
        })
      return true
    } catch (error) {
      unstored = chunk
      options.onError?.(error)
      return false
    }
  }

  const enqueue = (complete: boolean) => {
    clearTimeout(timer)
    timer = undefined
    const taken = buffer
    buffer = []
    const stored = chain.then(() => storeChunk(taken, complete))
    chain = stored.then(() => undefined)
    return stored
  }

  const push = (line: Omit<JobLogLine, 'n' | 'at'>) => {
    if (closed) return
    if (lines >= maxLines) {
      if (truncated) return
      truncated = true
      line = { text: `log truncated after ${maxLines} lines`, level: 'error' }
    }
    const step = steps.at(-1)
    const entry: JobLogLine = {
      n: lines++,
      at: now().toISOString(),
      ...(step !== undefined && { step }),
      ...line,
    }
    buffer.push(entry)
    if (entry.mark && marks.length < MAX_MARKS) {
      const { n, at, mark, ms } = entry
      marks.push({
        n,
        at,
        mark,
        ...(entry.step !== undefined && { step: entry.step }),
        ...(ms !== undefined && { ms }),
      })
    }
    if (buffer.length >= flushLines) void enqueue(false)
    else timer ??= setTimeout(() => void enqueue(false), flushMs)
  }

  return {
    write(text, fields) {
      push({ text, ...fields })
    },
    async step(name, run) {
      const started = now().getTime()
      push({ text: name, mark: 'start', step: name })
      steps.push(name)
      try {
        const result = await run()
        steps.pop()
        push({ text: name, mark: 'end', step: name, ms: now().getTime() - started })
        return result
      } catch (error) {
        steps.pop()
        if (failure?.error !== error) failure = { step: name, error }
        push({
          text: `${name} failed: ${messageOf(error)}`,
          mark: 'fail',
          level: 'error',
          step: name,
          ms: now().getTime() - started,
        })
        throw error
      }
    },
    get failedStep() {
      return failure?.step
    },
    async flush() {
      await enqueue(false)
    },
    async close() {
      if (closed) return chain
      closed = true
      for (let tries = 0; tries < CLOSE_TRIES; tries++)
        // oxlint-disable-next-line no-await-in-loop -- retries the last chunk in order
        if (await enqueue(true)) return
    },
  }
}

/**
 * A page of the log `createJobLog` stored for the attempt: from `offset`, or the last `tail`
 * lines. An attempt without a stored log reads as empty.
 */
export async function readJobLog(
  store: ArtifactStore,
  jobId: string,
  attempt: number,
  options: ReadJobLogOptions = {},
): Promise<JobLogPage> {
  const base = prefix(jobId, attempt)
  const head = isRefName(`${base}/head`) ? await store.getRef(`${base}/head`) : undefined
  const total = metaNumber(head?.meta, 'lines')
  const chunks = metaNumber(head?.meta, 'chunks')
  const complete = head?.meta?.complete === true
  const limit = Math.min(Math.max(1, options.limit ?? 500), MAX_LOG_PAGE)
  const from =
    options.tail !== undefined
      ? Math.max(0, total - Math.min(options.tail, MAX_LOG_PAGE))
      : Math.max(0, options.offset ?? 0)
  const to = options.tail !== undefined ? total : Math.min(total, from + limit)
  const steps = stepsOf(parseMarks(head?.meta))
  if (!head || from >= to)
    return { total, offset: Math.min(from, total), lines: [], complete, steps }

  const chunkRef = (index: number) => store.getRef(`${base}/${index}`)
  let low = 0
  let high = chunks - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    // oxlint-disable-next-line no-await-in-loop -- a binary search reads one ref per step
    const ref = await chunkRef(middle)
    if (metaNumber(ref?.meta, 'first') <= from) low = middle
    else high = middle - 1
  }

  const lines: JobLogLine[] = []
  for (let index = low; index < chunks; index++) {
    // oxlint-disable-next-line no-await-in-loop -- chunks are read in order until the page is full
    const ref = await chunkRef(index)
    if (!ref || metaNumber(ref.meta, 'first') >= to) break
    // oxlint-disable-next-line no-await-in-loop -- see above
    const artifact = await store.get(ref.id)
    if (!artifact) break
    for (const line of parseChunk(artifact.data))
      if (line.n >= from && line.n < to) lines.push(line)
    if (metaNumber(ref.meta, 'first') + metaNumber(ref.meta, 'count') >= to) break
  }
  return { total, offset: lines[0]?.n ?? from, lines, complete, steps }
}
