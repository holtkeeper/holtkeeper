import type { Block, GraphNode } from '@holtkeeper/api'
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import { useMemo } from 'react'

import {
  capGraph,
  edgeKey,
  groupedLayout,
  highlighted,
  layeredLayout,
  nodeWidth,
} from '../../../lib/graph.ts'
import { toneColor } from '../../../lib/units.ts'
import { Notice, useTheme } from '../../../ui/index.ts'
import { seriesColor } from '../tone.tsx'

const maxNodes = 250
const nodeHeight = 48

type ReportNodeData = { node: GraphNode; color: string; hot: boolean }
type ReportFlowNode = Node<ReportNodeData, 'report'>

function ReportNode({ data }: NodeProps<ReportFlowNode>) {
  const { node, color, hot } = data
  return (
    <div
      title={node.detail ?? node.label}
      className="flex h-full w-full items-center gap-2 overflow-hidden rounded-xl border bg-surface px-3 shadow-surface"
      style={{
        borderColor: hot ? 'var(--danger)' : 'var(--border)',
        boxShadow: hot
          ? '0 0 0 3px color-mix(in oklab, var(--danger) 25%, transparent)'
          : undefined,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-1.5 !border-0 !bg-border-tertiary"
      />
      <span aria-hidden className="h-6 w-1 shrink-0 rounded-full" style={{ background: color }} />
      <span className="min-w-0">
        <span className="block truncate font-mono text-[12px] font-medium">{node.label}</span>
        {node.detail ? (
          <span className="block truncate text-[10px] text-muted">{node.detail}</span>
        ) : null}
      </span>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-1.5 !border-0 !bg-border-tertiary"
      />
    </div>
  )
}

const nodeTypes = { report: ReportNode }

/** Nodes and edges laid out left to right; highlighted paths such as cycles are emphasized. */
export function GraphBlock({ block }: { block: Extract<Block, { type: 'graph' }> }) {
  const { theme } = useTheme()

  const groupOrder = useMemo(
    () => [...new Set(block.nodes.map((n) => n.group ?? ''))],
    [block.nodes],
  )

  const { nodes, edges, dropped } = useMemo(() => {
    const hot = highlighted(block.highlight, block.edges)
    const capped = capGraph(block.nodes, block.edges, maxNodes, hot.nodes)
    const maxSize = Math.max(0, ...capped.nodes.map((n) => n.size ?? 0))
    const boxes = capped.nodes.map((n) => ({
      id: n.id,
      group: n.group,
      width: nodeWidth(n.size, maxSize),
      height: nodeHeight,
    }))
    const placed =
      block.layout === 'force' ? groupedLayout(boxes) : layeredLayout(boxes, capped.edges)
    const position = new Map(placed.map((p) => [p.id, p]))

    const flowNodes: ReportFlowNode[] = capped.nodes.map((n) => {
      const p = position.get(n.id)
      return {
        id: n.id,
        type: 'report',
        position: { x: p?.x ?? 0, y: p?.y ?? 0 },
        width: p?.width ?? 120,
        height: nodeHeight,
        data: {
          node: n,
          color: n.tone ? toneColor[n.tone] : seriesColor(groupOrder.indexOf(n.group ?? '')),
          hot: hot.nodes.has(n.id),
        },
      }
    })
    const flowEdges: Edge[] = capped.edges.map((e, index) => {
      const isHot = hot.edges.has(edgeKey(e.from, e.to))
      const color = isHot ? 'var(--danger)' : e.tone ? toneColor[e.tone] : 'var(--border-tertiary)'
      return {
        id: `${e.from}->${e.to}#${index}`,
        source: e.from,
        target: e.to,
        animated: isHot,
        ...(e.label ? { label: e.label } : {}),
        style: {
          stroke: color,
          strokeWidth: isHot ? 2.5 : 1.25,
          ...(e.dashed ? { strokeDasharray: '5 4' } : {}),
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        zIndex: isHot ? 1 : 0,
      }
    })
    return { nodes: flowNodes, edges: flowEdges, dropped: capped.dropped }
  }, [block, groupOrder])

  const groups = groupOrder.filter(Boolean)

  return (
    <div className="flex flex-col gap-3">
      {dropped ? (
        <Notice tone="warning" title={`Showing ${nodes.length} of ${nodes.length + dropped} nodes`}>
          The most connected nodes and every highlighted path are kept; the rest is left out to stay
          readable.
        </Notice>
      ) : null}
      <div
        className="h-[32rem] overflow-hidden rounded-xl border border-border"
        role="figure"
        aria-label={`${block.title ?? 'Graph'}: ${block.nodes.length} nodes, ${block.edges.length} edges${block.highlight?.length ? `, ${block.highlight.length} highlighted paths` : ''}`}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.05}
          nodesConnectable={false}
          nodesDraggable
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n: ReportFlowNode) => n.data.color}
            maskColor="color-mix(in oklab, var(--background) 70%, transparent)"
          />
        </ReactFlow>
      </div>
      {groups.length > 1 || block.highlight?.length ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
          {groups.map((group) => (
            <li key={group} className="flex items-center gap-1.5">
              <span
                className="h-3 w-1 rounded-full"
                style={{ background: seriesColor(groupOrder.indexOf(group)) }}
              />
              {group}
            </li>
          ))}
          {block.highlight?.length ? (
            <li className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded-full bg-danger" />
              Highlighted path ({block.highlight.length})
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
