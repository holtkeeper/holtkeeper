import { motion } from 'motion/react'

import type { Slice } from '../../lib/dashboard.ts'

/** Ranked horizontal bars with direct value labels. */
export function BarList({
  items,
  unit,
  colorOf = () => 'var(--series-1)',
}: {
  items: Slice[]
  unit: string
  colorOf?: (name: string) => string
}) {
  const max = Math.max(1, ...items.map((item) => item.count))
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item, index) => (
        <li key={item.name} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: colorOf(item.name) }}
              />
              <span className="truncate">{item.name}</span>
            </span>
            <span className="tabular shrink-0 text-muted">
              {item.count} {unit}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-default">
            <motion.div
              className="h-full rounded-full"
              style={{ background: colorOf(item.name) }}
              initial={{ width: 0 }}
              animate={{ width: `${(item.count / max) * 100}%` }}
              transition={{ type: 'spring', stiffness: 140, damping: 24, delay: index * 0.03 }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
