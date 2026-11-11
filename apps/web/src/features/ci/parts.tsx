import type { ReactNode } from 'react'

import { type StatusTone, statusColor } from '../../ui/colors.ts'

/** Background and border of a box in a status tone, Graphite style: 11% fill, 24% border. */
export const toneBox = (tone: StatusTone) => ({
  background: `color-mix(in srgb, ${statusColor[tone]} 11%, transparent)`,
  borderColor: `color-mix(in srgb, ${statusColor[tone]} 24%, transparent)`,
})

/** One headline number: label, value, and a line of context under it. */
export function Figure({
  label,
  value,
  hint,
  children,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel px-3.5 py-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="mono text-[20px] font-semibold tracking-tight">{value}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  )
}
