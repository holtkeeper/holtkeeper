import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from '@xyflow/react'
import { X } from 'lucide-react'

/** Data of a `LinkEdge`: an optional caption and, when it can be undone, how. */
type LinkEdgeData = {
  label?: string
  /** Shows a × at the middle of the line; `removeLabel` names what it does. */
  onRemove?: () => void
  removeLabel?: string
}

/** An edge of an editable map. */
export type LinkEdge = Edge<LinkEdgeData, 'link'>

/**
 * A curved map edge with an optional caption and a × button for undoing the link. Register it as
 * `edgeTypes={{ link: LinkLine }}`.
 */
export function LinkLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps<LinkEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  if (!data?.label && !data?.onRemove)
    return (
      <BaseEdge
        id={id}
        path={path}
        {...(style ? { style } : {})}
        {...(markerEnd ? { markerEnd } : {})}
      />
    )
  const removeLabel = data.removeLabel ?? 'Remove this link'
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(style ? { style } : {})}
        {...(markerEnd ? { markerEnd } : {})}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {data.label ? (
            <span className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted shadow-surface">
              {data.label}
            </span>
          ) : null}
          {data.onRemove ? (
            <button
              type="button"
              aria-label={removeLabel}
              title={removeLabel}
              className="flex size-5 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-surface hover:border-danger hover:text-danger"
              onClick={data.onRemove}
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
