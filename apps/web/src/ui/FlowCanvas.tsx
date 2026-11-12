import type { LinkProps } from '@tanstack/react-router'
import {
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  useViewport,
} from '@xyflow/react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { type ComponentProps, type ReactNode, useState } from 'react'

import { type FlowEdgeSpec, type FlowNodeSpec, neighbours, placeFlow } from '../lib/flow.ts'
import { Button } from './Button.tsx'
import { statusColor } from './colors.ts'
import { SideSheet } from './SideSheet.tsx'
import { useTheme } from './theme.ts'

type SheetProps = ComponentProps<typeof SideSheet>

/** What the side drawer of a node shows; `undefined` from `drawer` makes the node read-only. */
export interface FlowDrawer {
  title: ReactNode
  /** Monospace id before the title, e.g. a branch or environment name. */
  id?: ReactNode
  content: ReactNode
  /** The node's own page; adds "Open as page" to the sheet. */
  openAsPage?: LinkProps
  /** A status bar under the sheet's header, e.g. the last runs of a schedule. */
  progress?: SheetProps['progress']
  /** At most two labelled buttons under the sheet's header. */
  quietActions?: SheetProps['quietActions']
  /** Secondary actions behind the sheet's "⋯" button. */
  more?: SheetProps['more']
  /** Underline tabs; `content` is drawn for the selected one. */
  tabs?: SheetProps['tabs']
}

type BoxData = { content: ReactNode; selected: boolean; editable: boolean; highlighted: boolean }
type BoxNode = Node<BoxData, 'box'>

const HANDLE = '!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent'

function Box({ data }: NodeProps<BoxNode>) {
  return (
    <div
      className={`flex h-full w-full flex-col justify-center overflow-hidden rounded-xl border bg-panel px-3 transition-colors ${
        data.selected
          ? 'border-[var(--brand)] shadow-[0_0_0_1px_var(--brand)]'
          : data.highlighted
            ? 'cursor-pointer border-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_8%,var(--panel))]'
            : data.editable
              ? 'cursor-pointer border-line-strong hover:border-[var(--fg-muted)]'
              : 'border-line'
      }`}
    >
      <Handle type="target" position={Position.Left} className={HANDLE} isConnectable={false} />
      {data.content}
      <Handle type="source" position={Position.Right} className={HANDLE} isConnectable={false} />
    </div>
  )
}

const nodeTypes = { box: Box }

const floatClass = 'flex items-center gap-1 rounded-lg border border-line bg-panel p-1 text-xs'

function ZoomControls() {
  const flow = useReactFlow()
  const { zoom } = useViewport()
  return (
    <div className={floatClass}>
      <Button
        isIconOnly
        variant="ghost"
        size="sm"
        aria-label="Zoom out"
        onPress={() => void flow.zoomOut()}
      >
        <Minus className="size-3.5" />
      </Button>
      <span className="mono w-10 text-center text-muted">{Math.round(zoom * 100)}%</span>
      <Button
        isIconOnly
        variant="ghost"
        size="sm"
        aria-label="Zoom in"
        onPress={() => void flow.zoomIn()}
      >
        <Plus className="size-3.5" />
      </Button>
      <Button
        isIconOnly
        variant="ghost"
        size="sm"
        aria-label="Fit to screen"
        onPress={() => void flow.fitView({ padding: 0.12, maxZoom: 1 })}
      >
        <Maximize className="size-3.5" />
      </Button>
    </div>
  )
}

/**
 * A read-only flow diagram drawn with React Flow in the Graphite style: nodes laid out left to
 * right, never dragged or connected, each drawn by the renderer of its `kind`. When `drawer`
 * returns something for a node, clicking it opens a side sheet with that content (usually a form)
 * and the sheet extras it names (progress, quiet actions, tabs, "Open as page"), and J/K step
 * through the other nodes that have one. Nothing about the drawing is stored, so
 * callers keep their own model and map it to nodes and edges. Pass `openId` with `onOpenChange`
 * to control which drawer is open, and `highlight` to mark nodes, e.g. a path; color its edges
 * with their `tone`. `controls` adds zoom buttons; `overlay` floats over the top left corner (a
 * notice) and `legend` over the bottom left one. The drawer's content may pin its own sticky
 * footer: the sheet body is the scroll container.
 */
export function FlowCanvas<N extends FlowNodeSpec>({
  nodes,
  edges,
  render,
  drawer,
  'aria-label': ariaLabel,
  maxHeight = 520,
  openId: controlledId,
  onOpenChange,
  highlight,
  controls = false,
  overlay,
  legend,
}: {
  nodes: readonly N[]
  edges: readonly FlowEdgeSpec[]
  /** Draws the inside of a node box; switch on `node.kind`. */
  render: (node: N) => ReactNode
  drawer?: (node: N) => FlowDrawer | undefined
  'aria-label': string
  maxHeight?: number
  openId?: string | undefined
  onOpenChange?: (id: string | undefined) => void
  highlight?: ReadonlySet<string>
  controls?: boolean
  overlay?: ReactNode
  legend?: ReactNode
}) {
  const { theme } = useTheme()
  const [ownId, setOwnId] = useState<string>()
  const openId = onOpenChange ? controlledId : ownId
  const setOpenId = onOpenChange ?? setOwnId
  const editable = drawer ? nodes.filter((node) => drawer(node) !== undefined) : []
  const editableIds = editable.map((node) => node.id)
  const open = editable.find((node) => node.id === openId)
  const content = open && drawer?.(open)
  const step = neighbours(editableIds, open?.id)
  const layout = placeFlow(nodes, edges)

  const flowNodes: BoxNode[] = layout.placed.map(({ node, x, y, width, height }) => ({
    id: node.id,
    type: 'box',
    position: { x, y },
    width,
    height,
    draggable: false,
    connectable: false,
    selectable: false,
    data: {
      content: render(node),
      selected: node.id === open?.id,
      editable: editableIds.includes(node.id),
      highlighted: highlight?.has(node.id) ?? false,
    },
  }))
  const flowEdges: Edge[] = edges.map((edge) => {
    const color = edge.tone ? statusColor[edge.tone] : 'var(--line-strong)'
    return {
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: 'smoothstep',
      selectable: false,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      style: {
        stroke: color,
        strokeWidth: 1.25,
        ...(edge.dashed ? { strokeDasharray: '4 4' } : {}),
      },
      ...(edge.label
        ? {
            label: edge.label,
            labelStyle: { fill: 'var(--fg-muted)', fontSize: 11 },
            labelBgStyle: { fill: 'var(--bg)' },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 4,
          }
        : {}),
    }
  })

  return (
    <>
      <div
        role="figure"
        aria-label={ariaLabel}
        className="overflow-hidden rounded-xl border border-line bg-sunk"
        style={{ height: Math.min(Math.max(layout.height + 64, 160), maxHeight) }}
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.3}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          zoomOnScroll={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            if (editableIds.includes(node.id)) setOpenId(node.id)
          }}
          onPaneClick={() => setOpenId(undefined)}
        >
          {overlay ? <Panel position="top-left">{overlay}</Panel> : null}
          {legend ? (
            <Panel position="bottom-left">
              <div className={`${floatClass} px-2.5 py-1.5`}>{legend}</div>
            </Panel>
          ) : null}
          {controls ? (
            <Panel position="bottom-right">
              <ZoomControls />
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
      <SideSheet
        open={content !== undefined}
        onClose={() => setOpenId(undefined)}
        title={content?.title ?? ''}
        {...(content?.id !== undefined ? { id: content.id } : {})}
        {...(step.index >= 0 ? { index: step.index, total: editableIds.length } : {})}
        {...(step.previous ? { onPrevious: () => setOpenId(step.previous) } : {})}
        {...(step.next ? { onNext: () => setOpenId(step.next) } : {})}
        {...(content?.openAsPage ? { openAsPage: content.openAsPage } : {})}
        {...(content?.progress ? { progress: content.progress } : {})}
        {...(content?.quietActions ? { quietActions: content.quietActions } : {})}
        {...(content?.more ? { more: content.more } : {})}
        {...(content?.tabs ? { tabs: content.tabs } : {})}
      >
        <div key={open?.id}>{content?.content}</div>
      </SideSheet>
    </>
  )
}
