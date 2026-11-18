import type { SeverityCounts } from './types.ts'

/** Severity counts with every severity at zero. */
export const emptySeverities = (): SeverityCounts => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  unknown: 0,
})
