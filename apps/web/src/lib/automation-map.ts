import type {
  ConfigEntryView,
  GroupMatch,
  JobAnalyzerView,
  ScheduleDocumentData,
  TriggerDocumentData,
} from '@holtkeeper/api'

import {
  describeCadence,
  describeTrigger,
  describeWindows,
  triggerAnalyzers,
} from './automation.ts'
import { formatGroupMatch, parseGroupMatch } from './scope.ts'

/** A schedule or trigger on the automation map. */
interface MapEvent {
  /** `schedule:<id>` or `trigger:<id>`. */
  id: string
  kind: 'schedule' | 'trigger'
  /** The config entry id. */
  entryId: string
  title: string
  /** When it fires, e.g. `Every day` or `A tag is pushed`. */
  when: string
  /** Extra limits beyond its groups, e.g. `only repos work:games/*`; empty when there are none. */
  scope: string
  /** Whether it can be limited to groups; label and command triggers run for any repository. */
  grouped: boolean
  enabled: boolean
}

/** A config group, a group intersection, or every group, as the source of events' scope. */
interface MapGroup {
  /** `group:<formatGroupMatch>`, or `group:*` for every group. */
  id: string
  label: string
  /** `undefined` for every group. */
  match?: GroupMatch
  /** No event is limited to it. */
  idle: boolean
}

/** An analyzer some event runs. */
interface MapAnalyzer {
  /** `analyzer:<kind>`. */
  id: string
  kind: string
  label: string
  /** `false` when the server does not know this kind: the event queues nothing for it. */
  known: boolean
  /** `group` analyzers run once per config group, not per repository. */
  scope?: 'repo' | 'group'
  /** No schedule or trigger runs it. */
  idle: boolean
}

/** What the automation map draws: events, the analyzers they queue and the links between them. */
export interface AutomationMap {
  groups: MapGroup[]
  events: MapEvent[]
  analyzers: MapAnalyzer[]
  /** `scope` edges run from a group to an event, `run` edges from an event to an analyzer. */
  edges: { from: string; to: string; kind: 'scope' | 'run'; enabled: boolean }[]
  /** Known analyzer kinds no schedule or trigger runs, sorted. */
  idle: string[]
}

/** Node id of the every-group source. */
export const ALL_GROUPS = 'group:*'

const groupNode = (match: GroupMatch) => `group:${formatGroupMatch(match)}`

/**
 * The automation map of the effective config: the groups each schedule and trigger is limited to
 * (every group when none), the events, and the analyzers each queues. Disabled schedules keep
 * their links, marked `enabled: false`. With `withIdle`, known analyzers and `groups` nothing uses
 * are nodes too, so an editor can link them.
 */
export function automationMap(
  schedules: readonly ConfigEntryView<'schedule'>[],
  triggers: readonly ConfigEntryView<'trigger'>[],
  known: readonly JobAnalyzerView[],
  { withIdle = false, groups = [] }: { withIdle?: boolean; groups?: readonly string[] } = {},
): AutomationMap {
  const byKind = new Map(known.map((analyzer) => [analyzer.kind, analyzer]))
  const events: MapEvent[] = []
  const edges: AutomationMap['edges'] = []
  const used = new Set<string>()
  const scopes = new Map<string, MapGroup>()
  const link = (event: MapEvent, kinds: readonly string[], limits?: readonly GroupMatch[]) => {
    if (event.grouped) {
      const sources = limits?.length
        ? limits.map((match) => ({ id: groupNode(match), label: formatGroupMatch(match), match }))
        : [{ id: ALL_GROUPS, label: 'Every group' }]
      for (const source of sources) {
        if (!scopes.has(source.id)) scopes.set(source.id, { ...source, idle: false })
        if (!edges.some((e) => e.from === source.id && e.to === event.id))
          edges.push({ from: source.id, to: event.id, kind: 'scope', enabled: event.enabled })
      }
    }
    for (const kind of new Set(kinds)) {
      used.add(kind)
      edges.push({ from: event.id, to: `analyzer:${kind}`, kind: 'run', enabled: event.enabled })
    }
  }

  for (const entry of schedules) {
    const data = entry.data
    const event: MapEvent = {
      id: `schedule:${entry.id}`,
      kind: 'schedule',
      entryId: entry.id,
      title: data.name || entry.id,
      when: [describeCadence(data), ...describeWindows(data.windows)].join(', '),
      scope: data.repos?.length ? `only repos ${data.repos.join(', ')}` : '',
      grouped: true,
      enabled: data.enabled,
    }
    events.push(event)
    link(event, data.analyzers, data.groups)
  }
  for (const entry of triggers) {
    const data = entry.data
    const event: MapEvent = {
      id: `trigger:${entry.id}`,
      kind: 'trigger',
      entryId: entry.id,
      title: entry.id,
      when: describeTrigger(data),
      scope: data.on === 'label' || data.on === 'command' ? 'any repository' : '',
      grouped: data.on !== 'label' && data.on !== 'command',
      enabled: true,
    }
    events.push(event)
    link(event, triggerAnalyzers(data), 'groups' in data ? data.groups : undefined)
  }

  const idle = known
    .map((analyzer) => analyzer.kind)
    .filter((kind) => !used.has(kind))
    .toSorted()
  const analyzers = [...used, ...(withIdle ? idle : [])].toSorted().map((kind): MapAnalyzer => {
    const view = byKind.get(kind)
    const id = `analyzer:${kind}`
    const isIdle = !used.has(kind)
    return view
      ? { id, kind, label: view.label, known: true, scope: view.scope, idle: isIdle }
      : { id, kind, label: kind, known: false, idle: isIdle }
  })
  if (withIdle) {
    for (const id of groups) {
      const node = groupNode(id)
      if (!scopes.has(node)) scopes.set(node, { id: node, label: id, match: id, idle: true })
    }
    if (!scopes.has(ALL_GROUPS))
      scopes.set(ALL_GROUPS, { id: ALL_GROUPS, label: 'Every group', idle: true })
  }
  const groupList = [...scopes.values()].toSorted(
    (a, b) =>
      Number(b.id === ALL_GROUPS) - Number(a.id === ALL_GROUPS) || a.label.localeCompare(b.label),
  )
  return { groups: groupList, events, analyzers, edges, idle }
}

type AutomationData = ScheduleDocumentData | TriggerDocumentData

/** `data` that also queues `kind`; a command trigger runs one analyzer, so `kind` replaces it. */
export function withAnalyzer<T extends AutomationData>(data: T, kind: string): T {
  if ('on' in data && data.on === 'command') return { ...data, analyzer: kind }
  if (data.analyzers.includes(kind)) return data
  return { ...data, analyzers: [...data.analyzers, kind] }
}

type Unlinked<T> = { data: T } | { error: string }

/**
 * `data` that no longer queues `kind`, dropping a schedule's options for it, or why not: every
 * schedule and trigger runs at least one analyzer.
 */
export function withoutAnalyzer(
  data: ScheduleDocumentData,
  kind: string,
): Unlinked<ScheduleDocumentData>
export function withoutAnalyzer(
  data: TriggerDocumentData,
  kind: string,
): Unlinked<TriggerDocumentData>
export function withoutAnalyzer(data: AutomationData, kind: string): Unlinked<AutomationData> {
  if ('on' in data && data.on === 'command')
    return { error: 'A command runs exactly one analyzer; link another one to replace it.' }
  const analyzers = data.analyzers.filter((analyzer) => analyzer !== kind)
  if (analyzers.length === data.analyzers.length) return { data }
  if (analyzers.length === 0)
    return { error: 'This is its only analyzer; remove the whole entry instead.' }
  if ('on' in data) return { data: { ...data, analyzers } }
  const { options, ...rest } = data
  const { [kind]: _dropped, ...kept } = options ?? {}
  return { data: { ...rest, analyzers, ...(Object.keys(kept).length ? { options: kept } : {}) } }
}

/**
 * `data` limited to `match` too, or to every group when `match` is `undefined`, or why not: label
 * and command triggers run for any repository. Limiting an every-group entry narrows it to `match`.
 */
export function withGroup(
  data: ScheduleDocumentData,
  match: GroupMatch | undefined,
): Unlinked<ScheduleDocumentData>
export function withGroup(
  data: TriggerDocumentData,
  match: GroupMatch | undefined,
): Unlinked<TriggerDocumentData>
export function withGroup(
  data: AutomationData,
  match: GroupMatch | undefined,
): Unlinked<AutomationData> {
  if ('on' in data && (data.on === 'label' || data.on === 'command'))
    return { error: 'Label and command triggers run for any repository.' }
  const next = { ...data }
  if (match === undefined) {
    delete next.groups
    return { data: next }
  }
  const key = formatGroupMatch(match)
  if (next.groups?.some((group) => formatGroupMatch(group) === key)) return { data }
  next.groups = [...(next.groups ?? []), parseGroupMatch(key)]
  return { data: next }
}

/**
 * `data` no longer limited to the group `label` (`formatGroupMatch` text), or why not: dropping
 * the last group would quietly widen it to every group.
 */
export function withoutGroup(
  data: ScheduleDocumentData,
  label: string,
): Unlinked<ScheduleDocumentData>
export function withoutGroup(
  data: TriggerDocumentData,
  label: string,
): Unlinked<TriggerDocumentData>
export function withoutGroup(data: AutomationData, label: string): Unlinked<AutomationData> {
  if ('on' in data && (data.on === 'label' || data.on === 'command')) return { data }
  const groups = (data.groups ?? []).filter((group) => formatGroupMatch(group) !== label)
  if (groups.length === (data.groups ?? []).length) return { data }
  if (groups.length === 0)
    return { error: 'This is its last group; link Every group to it to run it everywhere.' }
  return { data: { ...data, groups } }
}
