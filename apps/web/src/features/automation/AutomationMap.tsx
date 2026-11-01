import { useNavigate } from '@tanstack/react-router'
import {
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import { CalendarClock, Workflow, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useConfigEntries, useJobAnalyzers } from '../../api/queries.ts'
import { type AutomationMap as MapData, automationMap } from '../../lib/automation-map.ts'
import { layeredLayout } from '../../lib/graph.ts'
import { EmptyState, ErrorState, Panel, Placeholder, useTheme } from '../../ui/index.ts'

type EventData = { kind: 'schedule' | 'trigger'; title: string; when: string; scope: string }
type AnalyzerData = { label: string; detail: string; known: boolean }
type EventNode = Node<EventData & { enabled: boolean; dim: boolean }, 'event'>
type AnalyzerNode = Node<AnalyzerData & { dim: boolean }, 'analyzer'>

const EVENT = { width: 280, height: 68 }
const ANALYZER = { width: 200, height: 48 }

function EventCard({ data }: NodeProps<EventNode>) {
  const Icon = data.kind === 'schedule' ? CalendarClock : Zap
  return (
    <div
      className="flex h-full w-full cursor-pointer flex-col justify-center gap-0.5 overflow-hidden rounded-xl border border-border bg-surface px-3 shadow-surface transition-opacity"
      style={{
        opacity: data.dim ? 0.35 : data.enabled ? 1 : 0.6,
        borderStyle: data.enabled ? 'solid' : 'dashed',
      }}
      title={`${data.title}\n${data.when}\n${data.scope}${data.enabled ? '' : '\nOff'}`}
    >
      <span className="flex items-center gap-1.5 truncate text-[12px] font-medium">
        <Icon className="size-3.5 shrink-0 text-muted" />
        <span className="truncate">{data.title}</span>
        {data.enabled ? null : <span className="text-[10px] text-muted">off</span>}
      </span>
      <span className="truncate text-[11px]">{data.when}</span>
      <span className="truncate text-[10px] text-muted">{data.scope}</span>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-1.5 !border-0 !bg-border-tertiary"
      />
    </div>
  )
}

function AnalyzerCard({ data }: NodeProps<AnalyzerNode>) {
  return (
    <div
      className="flex h-full w-full flex-col justify-center overflow-hidden rounded-xl border bg-surface px-3 shadow-surface transition-opacity"
      style={{
        opacity: data.dim ? 0.35 : 1,
        borderColor: data.known ? 'var(--border)' : 'var(--danger)',
      }}
      title={`${data.label}: ${data.detail}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-1.5 !border-0 !bg-border-tertiary"
      />
      <span className="truncate text-[12px] font-medium">{data.label}</span>
      <span className="truncate font-mono text-[10px] text-muted">{data.detail}</span>
    </div>
  )
}

const nodeTypes = { event: EventCard, analyzer: AnalyzerCard }

function flowGraph(
  map: MapData,
  focus: string | null,
): { nodes: (EventNode | AnalyzerNode)[]; edges: Edge[]; height: number } {
  const near = new Set<string>()
  if (focus) {
    near.add(focus)
    for (const edge of map.edges) {
      if (edge.from === focus) near.add(edge.to)
      if (edge.to === focus) near.add(edge.from)
    }
  }
  const dim = (id: string) => focus !== null && !near.has(id)
  const placed = new Map(
    layeredLayout(
      [
        ...map.events.map((event) => ({ id: event.id, ...EVENT })),
        ...map.analyzers.map((analyzer) => ({ id: analyzer.id, ...ANALYZER })),
      ],
      map.edges,
    ).map((box) => [box.id, box]),
  )
  const position = (id: string) => {
    const box = placed.get(id)
    return { x: box?.x ?? 0, y: box?.y ?? 0 }
  }
  const nodes: (EventNode | AnalyzerNode)[] = [
    ...map.events.map((event): EventNode => ({
      id: event.id,
      type: 'event',
      position: position(event.id),
      ...EVENT,
      data: {
        kind: event.kind,
        title: event.title,
        when: event.when,
        scope: event.scope,
        enabled: event.enabled,
        dim: dim(event.id),
      },
      draggable: false,
    })),
    ...map.analyzers.map((analyzer): AnalyzerNode => ({
      id: analyzer.id,
      type: 'analyzer',
      position: position(analyzer.id),
      ...ANALYZER,
      data: {
        label: analyzer.label,
        detail: !analyzer.known
          ? `${analyzer.kind}: unknown, nothing runs`
          : analyzer.scope === 'group'
            ? `${analyzer.kind} · once per group`
            : analyzer.kind,
        known: analyzer.known,
        dim: dim(analyzer.id),
      },
      draggable: false,
    })),
  ]
  const edges: Edge[] = map.edges.map((edge) => {
    const lit = focus !== null && (edge.from === focus || edge.to === focus)
    return {
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: lit && edge.enabled,
      style: {
        stroke: lit ? 'var(--accent)' : 'var(--border-tertiary)',
        strokeDasharray: edge.enabled ? undefined : '4 4',
        opacity: focus !== null && !lit ? 0.3 : 1,
      },
    }
  })
  const height = Math.max(0, ...[...placed.values()].map((box) => box.y + box.height))
  return { nodes, edges, height }
}

/**
 * What runs when, at a glance: every schedule and trigger linked to the analyzers it queues.
 * Hovering a card highlights its links; clicking an event opens the tab that edits it.
 */
export function AutomationMap() {
  const { theme } = useTheme()
  const navigate = useNavigate({ from: '/automation' })
  const schedules = useConfigEntries('schedules')
  const triggers = useConfigEntries('triggers')
  const analyzers = useJobAnalyzers()
  const [focus, setFocus] = useState<string | null>(null)
  const map = useMemo(
    () =>
      automationMap(
        schedules.data?.entries ?? [],
        triggers.data?.entries ?? [],
        analyzers.data?.analyzers ?? [],
      ),
    [schedules.data, triggers.data, analyzers.data],
  )
  const graph = useMemo(() => flowGraph(map, focus), [map, focus])
  const error = schedules.error ?? triggers.error ?? analyzers.error

  return (
    <Panel
      title="Map"
      description="Every schedule and trigger with the analyzers it queues. Hover a card to follow its links, click a schedule or trigger to edit it. Dashed: switched off; red: an analyzer this server does not know."
    >
      {schedules.isPending || triggers.isPending || analyzers.isPending ? (
        <Placeholder className="h-64" />
      ) : error ? (
        <ErrorState error={error} />
      ) : map.events.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="Nothing runs automatically"
          description="Add a schedule or a trigger and it shows up here with the analyzers it runs."
        />
      ) : (
        <div className="flex flex-col gap-2">
          <div
            className="overflow-hidden rounded-xl border border-border"
            style={{ height: Math.min(graph.height + 48, 720) }}
            role="figure"
            aria-label={`Automation map: ${map.events.length} schedules and triggers, ${map.analyzers.length} analyzers`}
          >
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              colorMode={theme}
              fitView
              fitViewOptions={{ padding: 0.08 }}
              minZoom={0.3}
              nodesConnectable={false}
              nodesDraggable={false}
              elementsSelectable={false}
              zoomOnScroll={false}
              preventScrolling={false}
              onNodeMouseEnter={(_, node) => setFocus(node.id)}
              onNodeMouseLeave={() => setFocus(null)}
              onNodeClick={(_, node) => {
                const tab = node.type === 'event' ? `${node.data.kind}s` : undefined
                if (tab) void navigate({ search: (previous) => ({ ...previous, tab }) })
              }}
              proOptions={{ hideAttribution: true }}
            />
          </div>
          {map.idle.length ? (
            <p className="text-xs text-muted">Run only by hand: {map.idle.join(', ')}.</p>
          ) : null}
        </div>
      )}
    </Panel>
  )
}
