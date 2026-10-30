import { sparkPaths } from '../lib/sparkline.ts'

const WIDTH = 120
const HEIGHT = 32

/** A small trend line with a soft fill that stretches to its container; nothing under two points. */
export function MiniSparkline({
  values,
  color = 'var(--series-1)',
  label,
  className = 'h-8 w-full',
}: {
  values: readonly (number | null)[]
  color?: string
  label: string
  className?: string
}) {
  if (values.filter((v) => v !== null).length < 2) return null
  const paths = sparkPaths(values, WIDTH, HEIGHT, 3)
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={`overflow-visible ${className}`}
    >
      <path d={paths.area} fill={color} fillOpacity={0.12} />
      <path
        d={paths.line}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
