import type { ConfigEntryView, GroupMatch, JobAnalyzerView } from '@holtkeeper/api'

import {
  describeCadence,
  describeTrigger,
  describeWindows,
  triggerAnalyzers,
} from './automation.ts'
import { formatGroupMatch } from './scope.ts'

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
  /** Which repositories it covers, e.g. `every repository` or `groups games, web`. */
  scope: string
  enabled: boolean
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
}

/** What the automation map draws: events, the analyzers they queue and the links between them. */
export interface AutomationMap {
  events: MapEvent[]
  analyzers: MapAnalyzer[]
  edges: { from: string; to: string; enabled: boolean }[]
  /** Known analyzer kinds no schedule or trigger runs, sorted. */
  idle: string[]
}

function describeScope(groups?: readonly GroupMatch[], repos?: readonly string[]): string {
  const parts = [
    ...(groups?.length ? [`groups ${groups.map(formatGroupMatch).join(', ')}`] : []),
    ...(repos?.length ? [`repos ${repos.join(', ')}`] : []),
  ]
  return parts.length ? parts.join('; ') : 'every repository'
}

/**
 * The automation map of the effective config: every schedule and trigger, linked to the analyzers
 * it queues. Disabled schedules keep their links, marked `enabled: false`.
 */
export function automationMap(
  schedules: readonly ConfigEntryView<'schedule'>[],
  triggers: readonly ConfigEntryView<'trigger'>[],
  known: readonly JobAnalyzerView[],
): AutomationMap {
  const byKind = new Map(known.map((analyzer) => [analyzer.kind, analyzer]))
  const events: MapEvent[] = []
  const edges: AutomationMap['edges'] = []
  const used = new Set<string>()
  const link = (event: MapEvent, kinds: readonly string[]) => {
    for (const kind of new Set(kinds)) {
      used.add(kind)
      edges.push({ from: event.id, to: `analyzer:${kind}`, enabled: event.enabled })
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
      scope: describeScope(data.groups, data.repos),
      enabled: data.enabled,
    }
    events.push(event)
    link(event, data.analyzers)
  }
  for (const entry of triggers) {
    const data = entry.data
    const event: MapEvent = {
      id: `trigger:${entry.id}`,
      kind: 'trigger',
      entryId: entry.id,
      title: entry.id,
      when: describeTrigger(data),
      scope: describeScope('groups' in data ? data.groups : undefined),
      enabled: true,
    }
    events.push(event)
    link(event, triggerAnalyzers(data))
  }

  const analyzers = [...used].toSorted().map((kind): MapAnalyzer => {
    const view = byKind.get(kind)
    return view
      ? { id: `analyzer:${kind}`, kind, label: view.label, known: true, scope: view.scope }
      : { id: `analyzer:${kind}`, kind, label: kind, known: false }
  })
  const idle = known
    .map((analyzer) => analyzer.kind)
    .filter((kind) => !used.has(kind))
    .toSorted()
  return { events, analyzers, edges, idle }
}
