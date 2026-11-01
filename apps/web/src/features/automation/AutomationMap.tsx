import type { ConfigEntryView } from '@holtkeeper/api'
import {
  BaseEdge,
  type Connection,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  getBezierPath,
} from '@xyflow/react'
import { CalendarClock, Plus, Workflow, X, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useConfigEntries, useConfigMutations, useJobAnalyzers } from '../../api/queries.ts'
import {
  type AutomationMap as MapData,
  automationMap,
  withAnalyzer,
  withoutAnalyzer,
} from '../../lib/automation-map.ts'
import { layeredLayout } from '../../lib/graph.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  Panel,
  Placeholder,
  notify,
  useTheme,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { ScheduleDialog } from './ScheduleDialog.tsx'
import { TriggerDialog } from './TriggersTab.tsx'

type EventData = {
  kind: 'schedule' | 'trigger'
  title: string
  when: string
  scope: string
  enabled: boolean
  dim: boolean
  editable: boolean
}
type AnalyzerData = { label: string; detail: string; known: boolean; idle: boolean; dim: boolean }
type EventNode = Node<EventData, 'event'>
type AnalyzerNode = Node<AnalyzerData, 'analyzer'>
type LinkEdge = Edge<{ onRemove?: () => void }, 'link'>

const EVENT = { width: 280, height: 68 }
const ANALYZER = { width: 200, height: 48 }
const HANDLE = '!border-0 !bg-border-tertiary'

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
        className={`${HANDLE} ${data.editable ? '!size-3 !bg-accent-soft-foreground' : '!size-1.5'}`}
        title={data.editable ? 'Drag to an analyzer to run it here' : undefined}
      />
    </div>
  )
}

function AnalyzerCard({ data }: NodeProps<AnalyzerNode>) {
  return (
    <div
      className="flex h-full w-full flex-col justify-center overflow-hidden rounded-xl border bg-surface px-3 shadow-surface transition-opacity"
      style={{
        opacity: data.dim ? 0.35 : data.idle ? 0.6 : 1,
        borderColor: data.known ? 'var(--border)' : 'var(--danger)',
        borderStyle: data.idle ? 'dashed' : 'solid',
      }}
      title={`${data.label}: ${data.detail}`}
    >
      <Handle type="target" position={Position.Left} className={`${HANDLE} !size-1.5`} />
      <span className="truncate text-[12px] font-medium">{data.label}</span>
      <span className="truncate font-mono text-[10px] text-muted">{data.detail}</span>
    </div>
  )
}

function LinkLine({
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
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(style ? { style } : {})}
        {...(markerEnd ? { markerEnd } : {})}
      />
      {data?.onRemove ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Stop running this analyzer here"
            title="Stop running this analyzer here"
            className="nodrag nopan pointer-events-auto absolute flex size-5 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-surface hover:border-danger hover:text-danger"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={data.onRemove}
          >
            <X className="size-3" />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

const nodeTypes = { event: EventCard, analyzer: AnalyzerCard }
const edgeTypes = { link: LinkLine }

function flowGraph(
  map: MapData,
  focus: string | null,
  onRemove: ((from: string, to: string) => void) | undefined,
): { nodes: (EventNode | AnalyzerNode)[]; edges: LinkEdge[]; height: number } {
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
  const analyzerX = Math.max(
    EVENT.width + 72,
    ...map.analyzers.filter((a) => !a.idle).map((a) => placed.get(a.id)?.x ?? 0),
  )
  let idleY = Math.max(0, ...[...placed.values()].map((box) => box.y + box.height)) + 24
  for (const analyzer of map.analyzers) {
    if (!analyzer.idle) continue
    placed.set(analyzer.id, { id: analyzer.id, ...ANALYZER, x: analyzerX, y: idleY })
    idleY += ANALYZER.height + 16
  }
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
        editable: onRemove !== undefined,
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
          : analyzer.idle
            ? `${analyzer.kind} · not linked`
            : analyzer.scope === 'group'
              ? `${analyzer.kind} · once per group`
              : analyzer.kind,
        known: analyzer.known,
        idle: analyzer.idle,
        dim: dim(analyzer.id),
      },
      draggable: false,
    })),
  ]
  const edges: LinkEdge[] = map.edges.map((edge) => {
    const lit = focus !== null && (edge.from === focus || edge.to === focus)
    return {
      id: `${edge.from}->${edge.to}`,
      type: 'link',
      source: edge.from,
      target: edge.to,
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: lit && edge.enabled,
      style: {
        stroke: lit ? 'var(--accent)' : 'var(--border-tertiary)',
        strokeDasharray: edge.enabled ? undefined : '4 4',
        opacity: focus !== null && !lit ? 0.3 : 1,
      },
      data: lit && onRemove ? { onRemove: () => onRemove(edge.from, edge.to) } : {},
    }
  })
  const height = Math.max(0, ...[...placed.values()].map((box) => box.y + box.height))
  return { nodes, edges, height }
}

type Editing =
  | { kind: 'schedule'; entry?: ConfigEntryView<'schedule'> }
  | { kind: 'trigger'; entry?: ConfigEntryView<'trigger'> }

/**
 * What runs when: every schedule and trigger linked to the analyzers it queues. Hovering a card
 * highlights its links. With `settings:write`, dragging from a schedule or trigger to an analyzer
 * runs it there, the × on a highlighted link stops it, and clicking a card opens its form.
 */
export function AutomationMap() {
  const { theme } = useTheme()
  const { can } = useSession()
  const writable = can('settings:write')
  const schedules = useConfigEntries('schedules')
  const triggers = useConfigEntries('triggers')
  const analyzers = useJobAnalyzers()
  const scheduleMutations = useConfigMutations('schedules')
  const triggerMutations = useConfigMutations('triggers')
  const [focus, setFocus] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const scheduleList = useMemo(() => schedules.data?.entries ?? [], [schedules.data])
  const triggerList = useMemo(() => triggers.data?.entries ?? [], [triggers.data])
  const map = useMemo(
    () =>
      automationMap(scheduleList, triggerList, analyzers.data?.analyzers ?? [], {
        withIdle: writable,
      }),
    [scheduleList, triggerList, analyzers.data, writable],
  )
  const busy = scheduleMutations.put.isPending || triggerMutations.put.isPending

  const relink = (eventId: string, analyzerId: string, link: boolean) => {
    const kind = analyzerId.replace(/^analyzer:/, '')
    const event = map.events.find((e) => e.id === eventId)
    if (!event) return
    const done = {
      onSuccess: () =>
        notify.success(
          link ? `${event.title} runs ${kind}` : `${event.title} no longer runs ${kind}`,
        ),
      onError: (error: unknown) => notify.error('Not changed', messageOf(error)),
    }
    if (event.kind === 'schedule') {
      const entry = scheduleList.find((e) => e.id === event.entryId)
      if (!entry) return
      const next = link
        ? { data: withAnalyzer(entry.data, kind) }
        : withoutAnalyzer(entry.data, kind)
      if ('error' in next) notify.error('Not changed', next.error)
      else scheduleMutations.put.mutate({ id: entry.id, data: next.data }, done)
      return
    }
    const entry = triggerList.find((e) => e.id === event.entryId)
    if (!entry) return
    const next = link ? { data: withAnalyzer(entry.data, kind) } : withoutAnalyzer(entry.data, kind)
    if ('error' in next) notify.error('Not changed', next.error)
    else triggerMutations.put.mutate({ id: entry.id, data: next.data }, done)
  }

  const graph = flowGraph(
    map,
    focus,
    writable && !busy ? (from, to) => relink(from, to, false) : undefined,
  )
  const linked = new Set(map.edges.map((edge) => `${edge.from}->${edge.to}`))
  const canLink = (connection: Connection | Edge) =>
    connection.source.startsWith('schedule:') || connection.source.startsWith('trigger:')
      ? connection.target.startsWith('analyzer:') &&
        !linked.has(`${connection.source}->${connection.target}`)
      : false
  const openEvent = (eventId: string) => {
    const event = map.events.find((e) => e.id === eventId)
    if (!event) return
    if (event.kind === 'schedule') {
      const entry = scheduleList.find((e) => e.id === event.entryId)
      if (entry) setEditing({ kind: 'schedule', entry })
    } else {
      const entry = triggerList.find((e) => e.id === event.entryId)
      if (entry) setEditing({ kind: 'trigger', entry })
    }
  }
  const error = schedules.error ?? triggers.error ?? analyzers.error

  return (
    <Panel
      title="Map"
      description={
        writable
          ? 'Every schedule and trigger with the analyzers it queues. Drag from the dot of a card to an analyzer to run it there; hover a card and press × on a link to stop it; click a card to edit everything else. Dashed: switched off or not linked; red: an analyzer this server does not know.'
          : 'Every schedule and trigger with the analyzers it queues. Hover a card to follow its links. Dashed: switched off; red: an analyzer this server does not know.'
      }
      actions={
        writable ? (
          <>
            <Button variant="secondary" size="sm" onPress={() => setEditing({ kind: 'schedule' })}>
              <Plus className="size-4" />
              Schedule
            </Button>
            <Button variant="secondary" size="sm" onPress={() => setEditing({ kind: 'trigger' })}>
              <Plus className="size-4" />
              Trigger
            </Button>
          </>
        ) : null
      }
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
            onMouseLeave={() => setFocus(null)}
            role="figure"
            aria-label={`Automation map: ${map.events.length} schedules and triggers, ${map.analyzers.length} analyzers`}
          >
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              colorMode={theme}
              fitView
              fitViewOptions={{ padding: 0.08 }}
              minZoom={0.3}
              nodesConnectable={writable && !busy}
              nodesDraggable={false}
              elementsSelectable={false}
              deleteKeyCode={null}
              zoomOnScroll={false}
              preventScrolling={false}
              isValidConnection={canLink}
              onConnect={(connection) => relink(connection.source, connection.target, true)}
              onNodeMouseEnter={(_, node) => setFocus(node.id)}
              onEdgeMouseEnter={(_, edge) => setFocus(edge.source)}
              onPaneClick={() => setFocus(null)}
              onNodeClick={(_, node) => {
                if (node.type === 'event') openEvent(node.id)
              }}
              proOptions={{ hideAttribution: true }}
            />
          </div>
          {!writable && map.idle.length ? (
            <p className="text-xs text-muted">Run only by hand: {map.idle.join(', ')}.</p>
          ) : null}
        </div>
      )}

      {editing?.kind === 'schedule' ? (
        <ScheduleDialog
          key={editing.entry?.id ?? 'new'}
          {...(editing.entry ? { entry: editing.entry } : {})}
          taken={scheduleList.map((entry) => entry.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {editing?.kind === 'trigger' ? (
        <TriggerDialog
          key={editing.entry?.id ?? 'new'}
          {...(editing.entry ? { entry: editing.entry } : {})}
          taken={triggerList.map((entry) => entry.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Panel>
  )
}
