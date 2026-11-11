import type { ScopeView } from '../lib/home-scope.ts'
import { Segmented } from './Toggle.tsx'

const labels: Record<ScopeView, string> = {
  mine: 'My team',
  all: 'All I can see',
  others: 'Other teams',
}

/** The three-position scope switch of list pages, each position with its item count. */
export function ScopeSwitch({
  value,
  onChange,
  counts,
}: {
  value: ScopeView
  onChange: (view: ScopeView) => void
  counts?: Record<ScopeView, number>
}) {
  const options = (['mine', 'all', 'others'] as const).map((id) => ({
    id,
    label: (
      <span className="inline-flex items-center gap-1.5">
        {labels[id]}
        {counts ? <span className="tabular text-muted">{counts[id]}</span> : null}
      </span>
    ),
  }))
  return <Segmented aria-label="Scope" options={options} value={value} onChange={onChange} />
}
