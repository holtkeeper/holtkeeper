import type { ConfigEntryView, ScheduleDocumentData, TriggerDocumentData } from '@holtkeeper/api'
import {
  type Connection,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import { CalendarClock, FolderTree, Plus, Workflow, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useConfigEntries,
  useConfigMutations,
  useGroups,
  useJobAnalyzers,
} from '../../api/queries.ts'
import {
  ALL_GROUPS,
  type AutomationMap as MapData,
  automationMap,
  withAnalyzer,
  withGroup,
  withoutAnalyzer,
  withoutGroup,
} from '../../lib/automation-map.ts'
import { layeredLayout } from '../../lib/graph.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  type LinkEdge,
  LinkLine,
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
  grouped: boolean
  enabled: boolean
  dim: boolean
  editable: boolean
}
type GroupData = { label: string; every: boolean; idle: boolean; dim: boolean; editable: boolean }
type GroupNode = Node<GroupData, 'group'>
type AnalyzerData = { label: string; detail: string; known: boolean; idle: boolean; dim: boolean }
type EventNode = Node<EventData, 'event'>
type AnalyzerNode = Node<AnalyzerData, 'analyzer'>

const EVENT = { width: 280, height: 68 }
const ANALYZER = { width: 200, height: 48 }
const GROUP = { width: 180, height: 44 }
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
      title={[data.title, data.when, data.scope, data.enabled ? '' : 'Off']
        .filter(Boolean)
        .join('\n')}
    >
      {data.grouped ? (
        <Handle type="target" position={Position.Left} className={`${HANDLE} !size-1.5`} />
      ) : null}
      <span className="flex items-center gap-1.5 truncate text-[12px] font-medium">
        <Icon className="size-3.5 shrink-0 text-muted" />
        <span className="truncate">{data.title}</span>
        {data.enabled ? null : <span className="text-[10px] text-muted">off</span>}
      </span>
      <span className="truncate text-[11px]">{data.when}</span>
      {data.scope ? <span className="truncate text-[10px] text-muted">{data.scope}</span> : null}
      <Handle
        type="source"
        position={Position.Right}
        className={`${HANDLE} ${data.editable ? '!size-3 !bg-accent-soft-foreground' : '!size-1.5'}`}
        title={data.editable ? 'Drag to an analyzer to run it here' : undefined}
      />
    </div>
  )
}

function GroupCard({ data }: NodeProps<GroupNode>) {
  return (
    <div
      className="flex h-full w-full items-center gap-1.5 overflow-hidden rounded-xl border border-border bg-surface px-3 shadow-surface transition-opacity"
      style={{
        opacity: data.dim ? 0.35 : data.idle ? 0.6 : 1,
        borderStyle: data.idle ? 'dashed' : 'solid',
      }}
      title={data.every ? 'Every config group' : `Group ${data.label}`}
    >
      <FolderTree className="size-3.5 shrink-0 text-muted" />
      <span className={`truncate text-[12px] ${data.every ? 'italic' : 'font-mono'}`}>
        {data.label}
      </span>
      <Handle
        type="source"
        position={Position.Right}
        className={`${HANDLE} ${data.editable ? '!size-3 !bg-accent-soft-foreground' : '!size-1.5'}`}
        title={
          data.editable ? 'Drag to a schedule or trigger to limit it to this group' : undefined
        }
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

const nodeTypes = { group: GroupCard, event: EventCard, analyzer: AnalyzerCard }
const edgeTypes = { link: LinkLine }

function flowGraph(
  map: MapData,
  focus: string | null,
  onRemove: ((from: string, to: string) => void) | undefined,
): { nodes: (GroupNode | EventNode | AnalyzerNode)[]; edges: LinkEdge[]; height: number } {
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
        ...map.groups.map((group) => ({ id: group.id, ...GROUP })),
        ...map.events.map((event) => ({ id: event.id, ...EVENT })),
        ...map.analyzers.map((analyzer) => ({ id: analyzer.id, ...ANALYZER })),
      ],
      map.edges,
    ).map((box) => [box.id, box]),
  )
  const analyzerX = Math.max(
    GROUP.width + EVENT.width + 144,
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
  const nodes: (GroupNode | EventNode | AnalyzerNode)[] = [
    ...map.groups.map((group): GroupNode => ({
      id: group.id,
      type: 'group',
      position: position(group.id),
      ...GROUP,
      data: {
        label: group.label,
        every: group.id === ALL_GROUPS,
        idle: group.idle,
        dim: dim(group.id),
        editable: onRemove !== undefined,
      },
      draggable: false,
    })),
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
        grouped: event.grouped,
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
      data:
        lit && onRemove && edge.from !== ALL_GROUPS
          ? {
              onRemove: () => onRemove(edge.from, edge.to),
              removeLabel:
                edge.kind === 'run' ? 'Stop running this analyzer here' : 'Lift this group limit',
            }
          : {},
    }
  })
  const height = Math.max(0, ...[...placed.values()].map((box) => box.y + box.height))
  return { nodes, edges, height }
}

type Editing =
  | { kind: 'schedule'; entry?: ConfigEntryView<'schedule'> }
  | { kind: 'trigger'; entry?: ConfigEntryView<'trigger'> }

/**
 * What runs when and where: config groups → the schedules and triggers limited to them → the
 * analyzers they queue. Hovering a card highlights its links. With `settings:write`, dragging a
 * group onto an event limits it to that group, dragging an event onto an analyzer runs it there,
 * the × on a highlighted link undoes either, and clicking an event opens its form.
 */
export function AutomationMap() {
  const { theme } = useTheme()
  const { can } = useSession()
  const writable = can('settings:write')
  const schedules = useConfigEntries('schedules')
  const triggers = useConfigEntries('triggers')
  const analyzers = useJobAnalyzers()
  const groups = useGroups()
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
        groups: (groups.data?.entries ?? []).map((group) => group.id),
      }),
    [scheduleList, triggerList, analyzers.data, groups.data, writable],
  )
  const busy = scheduleMutations.put.isPending || triggerMutations.put.isPending

  type Change<T> = (data: T) => { data: T } | { error: string }
  const change = (
    eventId: string,
    message: string,
    onSchedule: Change<ScheduleDocumentData>,
    onTrigger: Change<TriggerDocumentData>,
  ) => {
    const event = map.events.find((e) => e.id === eventId)
    if (!event) return
    const done = {
      onSuccess: () => notify.success(message, event.title),
      onError: (error: unknown) => notify.error('Not changed', messageOf(error)),
    }
    if (event.kind === 'schedule') {
      const entry = scheduleList.find((e) => e.id === event.entryId)
      const next = entry && onSchedule(entry.data)
      if (!entry || !next) return
      if ('error' in next) notify.error('Not changed', next.error)
      else if (next.data !== entry.data)
        scheduleMutations.put.mutate({ id: entry.id, data: next.data }, done)
      return
    }
    const entry = triggerList.find((e) => e.id === event.entryId)
    const next = entry && onTrigger(entry.data)
    if (!entry || !next) return
    if ('error' in next) notify.error('Not changed', next.error)
    else if (next.data !== entry.data)
      triggerMutations.put.mutate({ id: entry.id, data: next.data }, done)
  }

  const connect = (from: string, to: string) => {
    if (to.startsWith('analyzer:')) {
      const kind = to.slice('analyzer:'.length)
      change(
        from,
        `Runs ${kind}`,
        (data) => ({ data: withAnalyzer(data, kind) }),
        (data) => ({ data: withAnalyzer(data, kind) }),
      )
      return
    }
    const group = map.groups.find((g) => g.id === from)
    if (!group) return
    const message = group.match === undefined ? 'Runs for every group' : `Limited to ${group.label}`
    change(
      to,
      message,
      (data) => withGroup(data, group.match),
      (data) => withGroup(data, group.match),
    )
  }

  const disconnect = (from: string, to: string) => {
    if (to.startsWith('analyzer:')) {
      const kind = to.slice('analyzer:'.length)
      change(
        from,
        `No longer runs ${kind}`,
        (data) => withoutAnalyzer(data, kind),
        (data) => withoutAnalyzer(data, kind),
      )
      return
    }
    const label = map.groups.find((g) => g.id === from)?.label ?? ''
    change(
      to,
      `No longer limited to ${label}`,
      (data) => withoutGroup(data, label),
      (data) => withoutGroup(data, label),
    )
  }

  const graph = flowGraph(map, focus, writable && !busy ? disconnect : undefined)
  const linked = new Set(map.edges.map((edge) => `${edge.from}->${edge.to}`))
  const canLink = (connection: Connection | Edge) => {
    if (linked.has(`${connection.source}->${connection.target}`)) return false
    if (connection.source.startsWith('group:'))
      return map.events.some((event) => event.id === connection.target && event.grouped)
    return (
      (connection.source.startsWith('schedule:') || connection.source.startsWith('trigger:')) &&
      connection.target.startsWith('analyzer:')
    )
  }
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
          ? 'Groups → schedules and triggers → analyzers. Drag from the dot of a group to a schedule or trigger to limit it to that group (Every group lifts the limit), from a schedule or trigger to an analyzer to run it there; hover a card and press × on a link to undo it; click a schedule or trigger to edit everything else. Dashed: switched off or not linked; red: an analyzer this server does not know.'
          : 'Groups → schedules and triggers → analyzers. Hover a card to follow its links. Dashed: switched off; red: an analyzer this server does not know.'
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
              onConnect={(connection) => connect(connection.source, connection.target)}
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
