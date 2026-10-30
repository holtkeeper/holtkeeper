import type { Tone } from '@holtkeeper/api'
import type { ReactNode } from 'react'

import { Chip } from '../../ui/index.ts'

const chipTone = {
  neutral: 'default',
  info: 'accent',
  good: 'success',
  warning: 'warning',
  bad: 'danger',
} as const

/** A report value with its tone as a chip. */
export function ToneChip({
  tone = 'neutral',
  children,
}: {
  tone?: Tone | undefined
  children: ReactNode
}) {
  return <Chip tone={chipTone[tone]}>{children}</Chip>
}

/** Categorical color for the n-th series or group; wraps after eight. */
export const seriesColor = (index: number) => `var(--series-${(index % 8) + 1})`
