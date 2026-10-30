import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '../../ui/index.ts'

export type Rail = 'when' | 'actions' | 'any' | 'all' | 'not' | 'sources' | 'rules' | 'outputs'

const RAIL: Record<Rail, { border: string; badge: string; text: string }> = {
  when: {
    border: 'border-accent',
    badge: 'bg-accent-soft text-accent-soft-foreground',
    text: 'If',
  },
  actions: { border: 'border-success', badge: 'bg-success-soft text-success', text: 'Then' },
  any: { border: 'border-warning', badge: 'bg-warning-soft text-warning', text: 'Any of' },
  all: {
    border: 'border-accent',
    badge: 'bg-accent-soft text-accent-soft-foreground',
    text: 'All of',
  },
  not: { border: 'border-danger', badge: 'bg-danger-soft text-danger', text: 'Not' },
  sources: {
    border: 'border-accent',
    badge: 'bg-accent-soft text-accent-soft-foreground',
    text: 'Sources',
  },
  rules: { border: 'border-warning', badge: 'bg-warning-soft text-warning', text: 'Rules' },
  outputs: { border: 'border-success', badge: 'bg-success-soft text-success', text: 'Outputs' },
}

/** A block with a coloured rail and a badge naming its role, e.g. `If`, `Then`, `Any of`. */
export function Railed({
  rail,
  hint,
  actions,
  children,
}: {
  rail: Rail
  hint?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const style = RAIL[rail]
  return (
    <div className={`flex flex-col gap-3 border-l-4 ${style.border} pl-3`}>
      <div className="flex items-center gap-2">
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${style.badge}`}
        >
          {style.text}
        </span>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
        {actions ? <span className="ml-auto flex gap-1">{actions}</span> : null}
      </div>
      {children}
    </div>
  )
}

/** An icon button that removes the block or row it sits in. */
export function RemoveButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Button variant="ghost" size="sm" isIconOnly aria-label={label} onPress={onPress}>
      <X className="size-3.5" />
    </Button>
  )
}
