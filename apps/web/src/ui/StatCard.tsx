import { motion } from 'motion/react'
import type { ReactNode } from 'react'

import { AnimatedNumber } from './AnimatedNumber.tsx'

/** A headline number with a label and optional accent color and hint. */
export function StatCard({
  label,
  value,
  hint,
  accent,
  icon,
}: {
  label: ReactNode
  value: number
  hint?: ReactNode
  /** CSS color for the accent stripe and icon. */
  accent?: string
  icon?: ReactNode
}) {
  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y: 8 }, shown: { opacity: 1, y: 0 } }}
      className="relative overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-surface"
    >
      {accent ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: accent }}
        />
      ) : null}
      <div className="flex items-center justify-between gap-2 text-sm text-muted">
        <span>{label}</span>
        {icon ? (
          <span className="[&_svg]:size-4" style={accent ? { color: accent } : undefined}>
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">
        <AnimatedNumber value={value} />
      </div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </motion.div>
  )
}
