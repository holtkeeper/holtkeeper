import type { Block, Tone } from '@holtkeeper/api'

type HeatmapBlock = Extract<Block, { type: 'heatmap' }>

/** How a heatmap cell is colored: a tone at a strength from 0 (blank) to 1 (full). */
export interface Heat {
  tone: Tone
  strength: number
}

/** The value at which a scale saturates: its `max`/`limit`, or the largest magnitude present. */
export function heatLimit(block: HeatmapBlock): number {
  const given = block.scale.kind === 'sequential' ? block.scale.max : block.scale.limit
  if (given !== undefined && given > 0) return given
  const values = block.yRows.flatMap((row) =>
    row.cells.flatMap((cell) => (cell ? [Math.abs(cell.value)] : [])),
  )
  return Math.max(0, ...values) || 1
}

/**
 * Color of one value. Sequential scales use their tone, diverging ones `good` or `bad` by the
 * direction `better` prefers; magnitudes past the limit saturate.
 */
export function heatOf(value: number, scale: HeatmapBlock['scale'], limit: number): Heat {
  const strength = Math.min(Math.abs(value) / limit, 1)
  if (scale.kind === 'sequential') return { tone: scale.tone, strength: value > 0 ? strength : 0 }
  if (value === 0) return { tone: 'neutral', strength: 0 }
  return { tone: value > 0 === (scale.better === 'up') ? 'good' : 'bad', strength }
}

/** Every `step`-th column label is shown so about `target` fit; the rest stay blank. */
export const labelStep = (columns: number, target = 12) => Math.max(1, Math.ceil(columns / target))
