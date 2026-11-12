import type { JobStats } from '@holtkeeper/api'

import { formatRelative } from '../../lib/format.ts'
import { queueFigures, waitBuckets, waitKindText, workerStateText } from '../../lib/jobs.ts'
import { Button, Dot, Strip } from '../../ui/index.ts'

function Workers({ stats, now }: { stats: JobStats; now: Date }) {
  const workers = stats.workers
  if (!workers) return null
  const newest = workers[0]?.lastSeen
  return (
    <div
      aria-label="Workers"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-3.5 py-2 text-xs"
    >
      <span className="text-muted">Workers</span>
      {workers.length ? (
        workers.map((worker) => (
          <span key={worker.id} className="inline-flex items-center gap-1.5">
            <Dot tone={worker.running > 0 ? 'info' : 'success'} />
            <span className="mono">{worker.id}</span>
            <span className="text-muted">{workerStateText(worker)}</span>
          </span>
        ))
      ) : (
        <span className="text-warn">No worker announced itself recently</span>
      )}
      {newest ? (
        <span className="ms-auto text-dim">heartbeat {formatRelative(newest, now)}</span>
      ) : null}
    </div>
  )
}

function WhyQueued({ stats, onQueue }: { stats: JobStats; onQueue?: () => void }) {
  const buckets = waitBuckets(stats)
  if (!buckets.length) return null
  return (
    <div
      aria-label="Why runs are queued"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3.5 py-2 text-xs text-muted"
    >
      <span>Why queued:</span>
      {buckets.map((bucket) => (
        <span key={bucket.kind} className="tabular">
          {waitKindText(bucket.kind, bucket.count)}
        </span>
      ))}
      {stats.waits.sampled < stats.queue.queued ? (
        <span className="text-dim tabular">of the {stats.waits.sampled} oldest</span>
      ) : null}
      {onQueue ? (
        <Button size="sm" variant="ghost" className="ms-auto" onPress={onQueue}>
          Open Queue view
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The queue at a glance from `GET /api/jobs/stats`: a strip of figures, the live workers (only
 * when the stats list them) and why the oldest queued runs wait.
 */
export function QueueHealth({
  stats,
  now,
  onQueue,
}: {
  stats: JobStats
  now: Date
  /** Switches to the Queue segment; left out while it is shown. */
  onQueue?: () => void
}) {
  return (
    <section aria-label="Queue health">
      <Strip label="Queue" cells={queueFigures(stats)} />
      <Workers stats={stats} now={now} />
      <WhyQueued stats={stats} {...(onQueue && { onQueue })} />
    </section>
  )
}
