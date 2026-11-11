import { type StatusTone, statusColor } from './colors.ts'

export interface Tick {
  /** `skipped` draws a neutral tick, for runs that did not happen or had no result. */
  tone: StatusTone | 'skipped'
  /** Shown on hover, e.g. the run's date and outcome. */
  label?: string
}

/** A strip of equal status ticks, oldest first, e.g. the last runs of a schedule. */
export function TickStrip({
  ticks,
  'aria-label': ariaLabel,
  className = '',
}: {
  ticks: readonly Tick[]
  'aria-label': string
  className?: string
}) {
  return (
    <div role="img" aria-label={ariaLabel} className={`flex h-[18px] gap-0.5 ${className}`}>
      {ticks.map((tick, index) => (
        <span
          key={index}
          className="h-full min-w-0.5 flex-1 rounded-[1.5px]"
          style={{
            background: tick.tone === 'skipped' ? 'var(--line-strong)' : statusColor[tick.tone],
          }}
          {...(tick.label ? { title: tick.label } : {})}
        />
      ))}
    </div>
  )
}
