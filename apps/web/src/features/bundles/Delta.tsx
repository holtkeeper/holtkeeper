import { formatValue } from '../../lib/units.ts'

/** A size change in bytes: growth in the danger color, shrinking in the success color. */
export function Delta({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="text-dim">—</span>
  if (value === 0) return <span className="mono text-muted">±0</span>
  return (
    <span className={`tabular mono ${value > 0 ? 'text-bad' : 'text-ok'}`}>
      {value > 0 ? '+' : '−'}
      {formatValue(Math.abs(value), 'bytes')}
    </span>
  )
}
