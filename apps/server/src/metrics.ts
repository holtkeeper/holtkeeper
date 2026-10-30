import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { Limiter } from '@holtkeeper/limits'
import type { Job, Store } from '@holtkeeper/store'

/** Upper bounds (seconds) of the job duration histogram. */
const jobDurationBuckets = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600] as const

type Labels = Record<string, string>

interface Sample {
  labels: Labels
  value: number
  /** Appended to the family name, e.g. `_bucket` for histograms. */
  suffix?: string
}

interface Family {
  name: string
  help: string
  type: 'counter' | 'gauge' | 'histogram'
  samples: Sample[]
}

const escape = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')

const labelText = (labels: Labels) => {
  const entries = Object.entries(labels)
  return entries.length
    ? `{${entries.map(([key, value]) => `${key}="${escape(value)}"`).join(',')}}`
    : ''
}

const number = (value: number) =>
  Number.isFinite(value) ? String(value) : value > 0 ? '+Inf' : value < 0 ? '-Inf' : 'NaN'

/** Prometheus text exposition format (version 0.0.4) of `families`, skipping empty ones. */
export function renderMetrics(families: readonly Family[]): string {
  const lines: string[] = []
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${family.type}`)
    for (const sample of family.samples) {
      lines.push(
        `${family.name}${sample.suffix ?? ''}${labelText(sample.labels)} ${number(sample.value)}`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

const keyOf = (labels: Labels) => JSON.stringify(Object.entries(labels))

class CounterSet {
  readonly values = new Map<string, Sample>()
  add(labels: Labels, by = 1) {
    const key = keyOf(labels)
    const sample = this.values.get(key) ?? { labels, value: 0 }
    sample.value += by
    this.values.set(key, sample)
  }
  samples() {
    return [...this.values.values()]
  }
}

class Histogram {
  readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >()
  readonly buckets: readonly number[]
  constructor(buckets: readonly number[]) {
    this.buckets = buckets
  }
  observe(labels: Labels, value: number) {
    const key = keyOf(labels)
    const entry = this.series.get(key) ?? {
      labels,
      counts: this.buckets.map(() => 0),
      sum: 0,
      count: 0,
    }
    this.buckets.forEach((bound, index) => {
      if (value <= bound) entry.counts[index] = (entry.counts[index] ?? 0) + 1
    })
    entry.sum += value
    entry.count += 1
    this.series.set(key, entry)
  }
  samples(): Sample[] {
    return [...this.series.values()].flatMap((entry) => [
      ...this.buckets.map((bound, index) => ({
        suffix: '_bucket',
        labels: { ...entry.labels, le: String(bound) },
        value: entry.counts[index] ?? 0,
      })),
      { suffix: '_bucket', labels: { ...entry.labels, le: '+Inf' }, value: entry.count },
      { suffix: '_sum', labels: entry.labels, value: entry.sum },
      { suffix: '_count', labels: entry.labels, value: entry.count },
    ])
  }
}

export interface MetricsOptions {
  store: Pick<Store, 'jobs' | 'aiUsage'>
  limiter?: Limiter
  artifacts?: ArtifactStore
  /**
   * Also report state read from the shared store (queued and running jobs, AI usage totals,
   * artifact bytes). Every process sharing a store reports the same values, so aggregate these
   * with `max`, not `sum`. Default `true`.
   */
  cluster?: boolean
  /** Artifact usage is listed at most this often (it can be slow on S3). Default 5 minutes. */
  artifactUsageTtlMs?: number
  /** Whether the process is draining; reported as `holtkeeper_draining`. */
  draining?: () => boolean
  now?: () => number
}

/** Process metrics and the `/metrics` page. */
export interface Metrics {
  /** Records a job that ended: duration histogram by analyzer and the finished counter. */
  observeJob(job: Job): void
  /** Records a forge webhook delivery answered with `status`. */
  observeWebhook(forge: string, status: number): void
  /** The current metrics in Prometheus text format. */
  render(): Promise<string>
}

const countLimit = 100_000

/** `undefined` when `read` fails, so one broken source does not empty the whole page. */
const safely = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/** Creates the metrics of one server process; store and limiter values are read on each render. */
export function createMetrics(options: MetricsOptions): Metrics {
  const { store } = options
  const now = options.now ?? Date.now
  const cluster = options.cluster ?? true
  const ttl = options.artifactUsageTtlMs ?? 300_000
  const finished = new CounterSet()
  const webhooks = new CounterSet()
  const durations = new Histogram(jobDurationBuckets)
  let artifactUsage: { at: number; bytes: number; count: number } | undefined

  async function jobFamilies(): Promise<Family[]> {
    const [queued, running] = await Promise.all([
      safely(() => store.jobs.list({ status: 'queued', limit: countLimit })),
      safely(() => store.jobs.list({ status: 'running', limit: countLimit })),
    ])
    if (!queued || !running) return []
    const at = now()
    const due = queued.filter((job) => Date.parse(job.runAfter) <= at).length
    return [
      {
        name: 'holtkeeper_jobs_queued',
        help: 'Queued jobs that are due now (scaling signal for workers).',
        type: 'gauge',
        samples: [{ labels: {}, value: due }],
      },
      {
        name: 'holtkeeper_jobs',
        help: 'Jobs by status in the shared queue.',
        type: 'gauge',
        samples: [
          { labels: { status: 'queued' }, value: queued.length },
          { labels: { status: 'running' }, value: running.length },
        ],
      },
    ]
  }

  async function aiFamilies(): Promise<Family[]> {
    const buckets = await safely(() => store.aiUsage.aggregate({ groupBy: ['provider', 'model'] }))
    if (!buckets) return []
    const labels = (key: (typeof buckets)[number]['key']) => ({
      provider: key.provider ?? '',
      model: key.model ?? '',
    })
    return [
      {
        name: 'holtkeeper_ai_runs_total',
        help: 'AI agent runs recorded.',
        type: 'counter',
        samples: buckets.map((b) => ({ labels: labels(b.key), value: b.runs })),
      },
      {
        name: 'holtkeeper_ai_tokens_total',
        help: 'AI tokens recorded, by kind.',
        type: 'counter',
        samples: buckets.flatMap((b) =>
          (
            [
              ['input', b.inputTokens],
              ['output', b.outputTokens],
              ['cache_read', b.cacheReadTokens],
              ['cache_write', b.cacheWriteTokens],
            ] as const
          ).map(([kind, value]) => ({ labels: { ...labels(b.key), kind }, value })),
        ),
      },
      {
        name: 'holtkeeper_ai_cost_usd_total',
        help: 'AI cost recorded, in US dollars.',
        type: 'counter',
        samples: buckets.map((b) => ({ labels: labels(b.key), value: b.costUsd })),
      },
    ]
  }

  async function artifactFamilies(): Promise<Family[]> {
    const artifacts = options.artifacts
    if (!artifacts) return []
    if (!artifactUsage || now() - artifactUsage.at >= ttl) {
      const usage = await safely(() => artifacts.usage())
      if (usage) artifactUsage = { at: now(), bytes: usage.bytes, count: usage.count }
    }
    if (!artifactUsage) return []
    return [
      {
        name: 'holtkeeper_artifact_store_bytes',
        help: 'Bytes in the artifact store.',
        type: 'gauge',
        samples: [{ labels: {}, value: artifactUsage.bytes }],
      },
      {
        name: 'holtkeeper_artifact_store_objects',
        help: 'Artifacts in the artifact store.',
        type: 'gauge',
        samples: [{ labels: {}, value: artifactUsage.count }],
      },
    ]
  }

  async function limiterFamilies(): Promise<Family[]> {
    const limiter = options.limiter
    if (!limiter) return []
    const snapshot = await safely(() => limiter.snapshot())
    if (!snapshot) return []
    const keys = Object.keys(snapshot).toSorted()
    const saturated = await Promise.all(
      keys.map(async (key) => ((await safely(() => limiter.saturated(key))) ? 1 : 0)),
    )
    return [
      {
        name: 'holtkeeper_limiter_saturated',
        help: '1 while a new caller of the credential would have to wait or be denied.',
        type: 'gauge',
        samples: keys.map((key, index) => ({ labels: { key }, value: saturated[index] ?? 0 })),
      },
      {
        name: 'holtkeeper_limiter_in_flight',
        help: 'Leases held on the credential.',
        type: 'gauge',
        samples: keys.map((key) => ({ labels: { key }, value: snapshot[key]?.inFlight ?? 0 })),
      },
      {
        name: 'holtkeeper_limiter_queued',
        help: 'Callers of this process waiting for the credential.',
        type: 'gauge',
        samples: keys.map((key) => ({ labels: { key }, value: snapshot[key]?.queued ?? 0 })),
      },
    ]
  }

  return {
    observeJob(job) {
      finished.add({ analyzer: job.analyzer, status: job.status })
      if (!job.startedAt) return
      const end = job.finishedAt ? Date.parse(job.finishedAt) : now()
      const seconds = Math.max(0, (end - Date.parse(job.startedAt)) / 1000)
      durations.observe({ analyzer: job.analyzer }, seconds)
    },
    observeWebhook(forge, status) {
      webhooks.add({ forge, status: String(status) })
    },
    async render() {
      const shared = cluster
        ? (await Promise.all([jobFamilies(), aiFamilies(), artifactFamilies()])).flat()
        : []
      const families: Family[] = [
        ...shared,
        {
          name: 'holtkeeper_jobs_finished_total',
          help: 'Jobs this process finished, by analyzer and final status.',
          type: 'counter',
          samples: finished.samples(),
        },
        {
          name: 'holtkeeper_job_duration_seconds',
          help: 'Duration of the last attempt of jobs this process finished.',
          type: 'histogram',
          samples: durations.samples(),
        },
        {
          name: 'holtkeeper_webhook_events_total',
          help: 'Forge webhook deliveries this process answered, by forge and HTTP status.',
          type: 'counter',
          samples: webhooks.samples(),
        },
        ...(await limiterFamilies()),
        {
          name: 'holtkeeper_draining',
          help: '1 while the process shuts down.',
          type: 'gauge',
          samples: [{ labels: {}, value: options.draining?.() ? 1 : 0 }],
        },
      ]
      return renderMetrics(families)
    },
  }
}
