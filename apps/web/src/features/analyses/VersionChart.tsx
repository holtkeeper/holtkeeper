import type { Metric } from '@holtkeeper/api'
import { ArrowLeftRight } from 'lucide-react'
import { useState } from 'react'

import type { VersionPoint } from '../../lib/analyses.ts'
import { formatDate, formatDateTime } from '../../lib/format.ts'
import { Button, Segmented } from '../../ui/index.ts'

const marker = (role: 'a' | 'b') => (
  <span
    aria-hidden
    className={`mono inline-grid size-4 place-items-center rounded-[4px] text-[10px] font-semibold ${
      role === 'b' ? 'bg-foreground text-background' : 'border border-line-strong text-foreground'
    }`}
  >
    {role.toUpperCase()}
  </span>
)

/**
 * The record page's mini chart: the repository's records of the same kind as bars of one metric,
 * oldest first, with A (compare base) and B (this record) marked. A bar click picks A or B as
 * the "Pick" switch says; Swap exchanges them.
 */
export function VersionChart({
  points,
  metrics,
  metric,
  onMetric,
  onPick,
  onSwap,
}: {
  points: readonly VersionPoint[]
  /** Metrics the chart can plot; a switch shows when there are several. */
  metrics: readonly Metric[]
  metric: Metric
  onMetric: (id: string) => void
  onPick: (role: 'a' | 'b', id: string) => void
  /** Leave out when there is no A. */
  onSwap?: () => void
}) {
  const [picking, setPicking] = useState<'a' | 'b'>('a')
  const a = points.find((point) => point.role === 'a')
  const b = points.find((point) => point.role === 'b')
  return (
    <section
      aria-labelledby="version-history"
      className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="version-history" className="m-0 text-[13px] font-semibold">
          Version history
        </h2>
        <span className="text-xs text-muted">Pick two records to compare · {metric.label}</span>
        <span className="flex-1" />
        {metrics.length > 1 ? (
          <Segmented
            aria-label="Metric"
            options={metrics.map((m) => ({ id: m.id, label: m.label }))}
            value={metric.id}
            onChange={onMetric}
          />
        ) : null}
        <Segmented
          aria-label="Pick"
          options={[
            { id: 'a', label: 'Pick A' },
            { id: 'b', label: 'Pick B' },
          ]}
          value={picking}
          onChange={(id) => setPicking(id === 'b' ? 'b' : 'a')}
        />
        <span className="inline-flex items-center gap-1.5 text-xs">
          {marker('a')}
          <span className="text-muted">base</span>
          <span className="mono">{a ? formatDate(a.createdAt) : 'previous'}</span>
          <span className="ms-1.5">{marker('b')}</span>
          <span className="text-muted">this record</span>
          {b ? <span className="mono">{formatDate(b.createdAt)}</span> : null}
        </span>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={!onSwap}
          {...(onSwap ? { onPress: onSwap } : {})}
        >
          <ArrowLeftRight className="size-3.5" />
          Swap
        </Button>
      </div>
      <div
        role="group"
        aria-label="Records, oldest to newest"
        className="flex items-end gap-1 overflow-x-auto pb-1"
      >
        {points.map((point) => {
          const label = [
            `Record of ${formatDateTime(point.createdAt)}`,
            point.text,
            point.tag ? `release ${point.tag}` : undefined,
            point.role === 'a' ? 'compare base' : point.role === 'b' ? 'this record' : undefined,
          ]
            .filter(Boolean)
            .join(', ')
          return (
            <button
              key={point.id}
              type="button"
              aria-label={label}
              aria-pressed={point.role !== undefined}
              title={label}
              disabled={point.role !== undefined}
              onClick={() => onPick(picking, point.id)}
              className={`flex w-12 shrink-0 flex-col items-center gap-1 rounded-md px-1 py-1 text-[10.5px] hover:bg-raise disabled:cursor-default ${
                point.role ? 'bg-raise' : ''
              }`}
            >
              <span className="h-3.5 truncate text-dim">{point.tag ?? ''}</span>
              <span className="flex h-14 w-full items-end justify-center">
                <span
                  className={`w-4 rounded-t-[3px] ${
                    point.role === 'b'
                      ? 'bg-foreground'
                      : point.role === 'a'
                        ? 'bg-muted'
                        : 'bg-line-strong'
                  }`}
                  style={{
                    height: `${Math.max(point.height * 100, point.value === undefined ? 0 : 6)}%`,
                  }}
                />
              </span>
              <span className="mono w-full truncate text-center">{point.text}</span>
              <span className="w-full truncate text-center text-dim">
                {formatDate(point.createdAt)}
              </span>
              {point.role ? marker(point.role) : <span aria-hidden className="h-4" />}
            </button>
          )
        })}
      </div>
    </section>
  )
}
