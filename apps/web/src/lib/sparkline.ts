export interface SparkPaths {
  /** SVG path of the line; consecutive values only, `null` breaks it. */
  line: string
  /** The line closed down to the baseline, for a soft fill. */
  area: string
  /** Last defined point, for a dot. */
  last?: { x: number; y: number }
}

const fixed = (n: number) => Math.round(n * 10) / 10

/**
 * Paths of a sparkline of `values` in a `width` × `height` box with `pad` inset. The y range runs
 * from 0 (or the smallest value when negative) to the largest; a single point draws a dot only.
 */
export function sparkPaths(
  values: readonly (number | null)[],
  width: number,
  height: number,
  pad = 2,
): SparkPaths {
  const defined = values.filter((v) => v !== null)
  if (!defined.length) return { line: '', area: '' }
  const low = Math.min(0, ...defined)
  const high = Math.max(...defined)
  const span = high - low || 1
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0
  const x = (index: number) => pad + index * step
  const y = (value: number) => height - pad - ((value - low) / span) * (height - pad * 2)
  const runs: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] = []
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) runs.push(current)
      current = []
    } else current.push({ x: x(index), y: y(value) })
  })
  if (current.length) runs.push(current)
  const path = (points: { x: number; y: number }[]) =>
    points.map((p, i) => `${i ? 'L' : 'M'}${fixed(p.x)} ${fixed(p.y)}`).join(' ')
  const drawn = runs.filter((run) => run.length > 1)
  const baseline = fixed(y(Math.max(low, 0)))
  const lastRun = runs.at(-1)
  const last = lastRun?.at(-1)
  return {
    line: drawn.map(path).join(' '),
    area: drawn
      .map(
        (run) =>
          `${path(run)} L${fixed(run.at(-1)?.x ?? 0)} ${baseline} L${fixed(run[0]?.x ?? 0)} ${baseline} Z`,
      )
      .join(' '),
    ...(last ? { last: { x: fixed(last.x), y: fixed(last.y) } } : {}),
  }
}
