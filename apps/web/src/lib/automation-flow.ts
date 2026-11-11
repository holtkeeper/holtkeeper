import type {
  ConfigEntryView,
  GroupMatch,
  Job,
  JobAnalyzerView,
  Scope,
  SettingView,
  TriggerDocumentData,
} from '@holtkeeper/api'

import { describeCadence, describeWindows, mergeRequestActions } from './automation.ts'
import type { FlowEdgeSpec, FlowNodeSpec } from './flow.ts'
import { type ConditionValue, describeCondition, normalizePolicies } from './policies.ts'
import { formatGroupMatch } from './scope.ts'

/** Settings key of merge request policies, edited on the Automation page. */
export const POLICIES_KEY = 'mergeRequests.policies'
/** Settings key of a team's freshness override. */
export const FRESHNESS_KEY = 'freshness'
/** Settings key of the freshness sweeper's limits. */
const FRESHNESS_SWEEP_KEY = 'freshness.sweep'
/** Settings edited only on the Automation page, so Settings leaves them out. */
export const automationSettingKeys: ReadonlySet<string> = new Set([POLICIES_KEY, FRESHNESS_KEY])

/** What starts automatic work. */
export type AutomationEvent =
  | 'push'
  | 'tag'
  | 'mergeRequest'
  | 'label'
  | 'command'
  | 'newRepo'
  | 'schedule'
  | 'freshness'

const eventOrder: readonly AutomationEvent[] = [
  'push',
  'tag',
  'mergeRequest',
  'label',
  'command',
  'newRepo',
  'schedule',
  'freshness',
]

/** How each event is called on the canvas. */
const eventLabels: Record<AutomationEvent, string> = {
  push: 'Push',
  tag: 'Tag',
  mergeRequest: 'Merge request',
  label: 'Label added',
  command: 'Command',
  newRepo: 'New repository',
  schedule: 'Schedule',
  freshness: 'Freshness',
}

/** The stored document a rule node stands for. */
export type RuleRef =
  | { type: 'trigger'; id: string }
  | { type: 'schedule'; id: string }
  | { type: 'policy'; settingId: string; policyId: string }
  | { type: 'freshness' }
  | { type: 'release' }

/** What an action node does: one analyzer, review, a release step, a policy action or a set of analyzers. */
export type ActionKind = 'analyzer' | 'review' | 'release' | 'policy' | 'analyzers'

/** Data of a rule node. */
interface RuleData {
  ref: RuleRef
  title: string
  /** Its conditions and limits in a few words each. */
  chips: string[]
  enabled: boolean
  /** Some action may call an LLM. */
  ai: boolean
  events: AutomationEvent[]
  /** Analyzer kinds it queues by name. */
  analyzers: string[]
  /** An action node that stands for a set of analyzers, minus `except`. */
  wildcard?: { node: string; except: string[] }
}

/** A node of an automation lane. */
export type AutomationNode =
  | FlowNodeSpec<'event', { event: AutomationEvent; label: string }>
  | FlowNodeSpec<'rule', RuleData>
  | FlowNodeSpec<'action', { action: ActionKind; label: string; kind?: string; ai: boolean }>

/** One team's part of the automation: config group lanes, plus one for every repository. */
export interface AutomationLane {
  /** `all`, or the group id. */
  id: string
  group?: string
  label: string
  nodes: AutomationNode[]
  edges: FlowEdgeSpec[]
}

/** Lane id of rules that cover every repository. */
export const ALL_LANE = 'all'

/** A team's freshness override as the sweeper reads it. */
export interface LaneFreshness {
  mode: 'on' | 'off' | 'slower'
  factor: number
  /** The setting that decides it; absent when the default applies. */
  entry?: SettingView
  /** `entry` is the every-repository one, not the team's own. */
  inherited: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const freshnessValue = (value: unknown): Pick<LaneFreshness, 'mode' | 'factor'> => {
  const record = isRecord(value) ? value : {}
  const mode = record.mode === 'off' || record.mode === 'slower' ? record.mode : 'on'
  const factor = typeof record.factor === 'number' && record.factor >= 1 ? record.factor : 3
  return { mode, factor }
}

/**
 * The freshness override of a team (`group`) or of every repository: the group's own entry (scoped
 * to exactly that group), else an entry shared with other groups, else the every-repository entry,
 * else on. Only the own entry is `inherited: false`, so editing a team never rewrites a shared one.
 */
export function laneFreshness(
  settings: readonly SettingView[],
  group: string | undefined,
): LaneFreshness {
  const entries = settings.filter((entry) => entry.key === FRESHNESS_KEY && !entry.secret)
  const own =
    group === undefined
      ? entries.find((entry) => entry.scope.all)
      : entries.find(
          (entry) =>
            !entry.scope.all &&
            !entry.scope.repos?.length &&
            entry.scope.groups?.length === 1 &&
            entry.scope.groups[0] === group,
        )
  if (own) return { ...freshnessValue(own.value), entry: own, inherited: false }
  const shared =
    group === undefined
      ? undefined
      : entries.find(
          (entry) =>
            !entry.scope.all &&
            !entry.scope.repos?.length &&
            entry.scope.groups?.some((match) => match === group),
        )
  if (shared) return { ...freshnessValue(shared.value), entry: shared, inherited: true }
  const all = group === undefined ? undefined : entries.find((entry) => entry.scope.all)
  if (all) return { ...freshnessValue(all.value), entry: all, inherited: true }
  return { mode: 'on', factor: 3, inherited: group !== undefined }
}

const memberGroups = (matches: readonly GroupMatch[] | undefined): string[] =>
  matches?.length
    ? [...new Set(matches.flatMap((match) => (typeof match === 'string' ? [match] : match)))]
    : [ALL_LANE]

const scopeLanes = (scope: Scope): string[] =>
  scope.all || !scope.groups?.length ? [ALL_LANE] : memberGroups(scope.groups)

const joined = (items: readonly string[]) => items.join(', ')

const intersectionChips = (matches: readonly GroupMatch[] | undefined): string[] =>
  (matches ?? [])
    .filter((match) => typeof match !== 'string')
    .map((m) => `only ${formatGroupMatch(m)}`)

/** The title a trigger has on the canvas. */
function triggerTitle(trigger: TriggerDocumentData): string {
  switch (trigger.on) {
    case 'tag':
      return 'Tag pushed'
    case 'push':
      return 'Branch push'
    case 'mergeRequest':
      return 'Merge request changes'
    case 'newRepo':
      return 'New repository'
    case 'label':
      return `Label ${trigger.label}`
  }
  return `/holtkeeper ${trigger.command}`
}

function triggerChips(trigger: TriggerDocumentData): string[] {
  switch (trigger.on) {
    case 'push':
      return [trigger.branches?.length ? `branches ${joined(trigger.branches)}` : 'any branch']
    case 'mergeRequest':
      return [
        ...(trigger.actions?.length && trigger.actions.length < mergeRequestActions.length
          ? [`on ${joined(trigger.actions)}`]
          : []),
        ...(trigger.draft ? ['drafts too'] : []),
      ]
    case 'newRepo':
      return trigger.exclude?.length ? [`skips ${joined(trigger.exclude)}`] : []
    case 'command':
      return trigger.args?.length ? [`args ${joined(trigger.args)}`] : []
    default:
      return []
  }
}

const policyActionLabels: Record<string, string> = {
  approve: 'Approve',
  merge: 'Merge',
  label: 'Label',
  comment: 'Comment',
  assignReviewers: 'Request reviewers',
  draft: 'Draft or ready',
  close: 'Close',
  webhook: 'Webhook',
}

/** Events a policy reacts to, from its `when`; merge request changes when it names none. */
export function policyEvents(when: ConditionValue): AutomationEvent[] {
  const events = new Set<AutomationEvent>()
  for (const event of when.event ?? [])
    events.add(event === 'label' ? 'label' : event === 'command' ? 'command' : 'mergeRequest')
  if (when.labelAdded?.length) events.add('label')
  if (when.command?.length) events.add('command')
  if (!events.size) events.add('mergeRequest')
  return eventOrder.filter((event) => events.has(event))
}

interface ActionSpec {
  id: string
  action: ActionKind
  label: string
  kind?: string
  ai: boolean
}

interface RuleSpec extends RuleData {
  id: string
  lanes: string[]
  actions: ActionSpec[]
}

/** Everything the canvas projects. */
export interface AutomationInput {
  /** Config group ids. */
  groups: readonly string[]
  triggers: readonly ConfigEntryView<'trigger'>[]
  schedules: readonly ConfigEntryView<'schedule'>[]
  /** Settings entries; only `mergeRequests.policies` and `freshness` ones are read. */
  settings: readonly SettingView[]
  analyzers: readonly JobAnalyzerView[]
}

/** Node id of a rule. */
function ruleNodeId(ref: RuleRef): string {
  switch (ref.type) {
    case 'trigger':
      return `rule:trigger:${ref.id}`
    case 'schedule':
      return `rule:schedule:${ref.id}`
    case 'policy':
      return `rule:policy:${ref.settingId}:${ref.policyId}`
  }
  return `rule:${ref.type}`
}

const sizes = {
  event: { width: 150, height: 40 },
  rule: { width: 250, height: 76 },
  action: { width: 190, height: 40 },
}

/**
 * Lanes of the automation canvas, projected from the stored documents (nothing here is stored):
 * one for every repository, then one per config group. Each lane links event nodes to the rules
 * (triggers, merge request policies, schedules, freshness and the release assistant) that react
 * to them, and rules to the actions they take. A rule limited to groups sits in each member
 * group's lane; one without groups, or limited to repositories only, in the every-repository
 * lane. Freshness has a rule in every lane, with that lane's override. Disabled rules draw dashed.
 */
export function automationLanes(input: AutomationInput): AutomationLane[] {
  const byKind = new Map(input.analyzers.map((analyzer) => [analyzer.kind, analyzer]))
  const usesAgent = (kind: string) => byKind.get(kind)?.needs.agent !== undefined
  const analyzerAction = (kind: string): ActionSpec => ({
    id: `analyzer:${kind}`,
    action: kind === 'review' ? 'review' : 'analyzer',
    label: byKind.get(kind)?.label ?? kind,
    kind,
    ai: usesAgent(kind),
  })
  const rules: RuleSpec[] = []
  const add = (spec: Omit<RuleSpec, 'id' | 'ai'>) =>
    rules.push({ ...spec, id: ruleNodeId(spec.ref), ai: spec.actions.some((a) => a.ai) })

  for (const entry of input.triggers) {
    const data = entry.data
    const anyRepo = data.on === 'label' || data.on === 'command'
    const groups = 'groups' in data ? data.groups : undefined
    const base = {
      ref: { type: 'trigger' as const, id: entry.id },
      title: triggerTitle(data),
      chips: [...triggerChips(data), ...intersectionChips(groups)],
      enabled: true,
      events: [data.on],
      lanes: anyRepo ? [ALL_LANE] : memberGroups(groups),
    }
    if (data.on === 'newRepo' && !data.analyzers?.length) {
      const kinds = input.analyzers
        .filter((a) => a.scope === 'repo' && !a.exclusive && !data.exclude?.includes(a.kind))
        .map((a) => a.kind)
      add({
        ...base,
        analyzers: [],
        wildcard: { node: 'action:read-only', except: [...(data.exclude ?? [])] },
        actions: [
          {
            id: 'action:read-only',
            action: 'analyzers',
            label: 'Every read-only analyzer',
            ai: kinds.some(usesAgent),
          },
        ],
      })
      continue
    }
    const kinds = data.on === 'command' ? [data.analyzer] : (data.analyzers ?? [])
    add({
      ...base,
      analyzers: [...new Set(kinds)],
      actions: [...new Set(kinds)].map(analyzerAction),
    })
  }

  for (const entry of input.settings) {
    if (entry.key !== POLICIES_KEY || entry.secret) continue
    const lanes = scopeLanes(entry.scope)
    const repoChip =
      !entry.scope.all && !entry.scope.groups?.length && entry.scope.repos?.length
        ? [`only ${joined(entry.scope.repos)}`]
        : []
    for (const policy of normalizePolicies(entry.value)) {
      const kinds = [
        ...new Set(
          policy.actions.flatMap((action) =>
            action.type === 'enqueue' && typeof action.analyzer === 'string'
              ? [action.analyzer]
              : [],
          ),
        ),
      ]
      const others = [...new Set(policy.actions.map((a) => a.type).filter((t) => t !== 'enqueue'))]
      const mrEvents = (policy.when.event ?? []).filter((e) => e !== 'label' && e !== 'command')
      const { event: _event, ...conditions } = policy.when
      add({
        ref: { type: 'policy', settingId: entry.id, policyId: policy.id },
        title: policy.name || policy.id,
        chips: [
          ...(mrEvents.length ? [`on ${joined(mrEvents)}`] : []),
          ...describeCondition(conditions),
          ...(policy.skipAnalyzers === '*'
            ? ['skips all analyzers']
            : policy.skipAnalyzers?.length
              ? [`skips ${joined(policy.skipAnalyzers)}`]
              : []),
          ...(policy.stop ? ['stops later policies'] : []),
          ...repoChip,
        ],
        enabled: policy.enabled,
        events: policyEvents(policy.when),
        analyzers: kinds,
        lanes,
        actions: [
          ...others.map((type) => ({
            id: `action:policy:${type}`,
            action: 'policy' as const,
            label: policyActionLabels[type] ?? type,
            ai: false,
          })),
          ...kinds.map(analyzerAction),
        ],
      })
    }
  }

  for (const entry of input.schedules) {
    const data = entry.data
    add({
      ref: { type: 'schedule', id: entry.id },
      title: data.name || entry.id,
      chips: [
        describeCadence(data),
        ...describeWindows(data.windows),
        ...(data.repos?.length ? [`only ${joined(data.repos)}`] : []),
        ...intersectionChips(data.groups),
      ],
      enabled: data.enabled,
      events: ['schedule'],
      analyzers: [...new Set(data.analyzers)],
      lanes: memberGroups(data.groups),
      actions: [...new Set(data.analyzers)].map(analyzerAction),
    })
  }

  const fresh = input.analyzers.filter((analyzer) => analyzer.refresh !== undefined)
  const lanes: { id: string; group?: string; label: string }[] = [
    { id: ALL_LANE, label: 'All repositories' },
    ...[...new Set(input.groups)].toSorted().map((group) => ({ id: group, group, label: group })),
  ]

  return lanes.map((lane) => {
    const own = rules.filter((rule) => rule.lanes.includes(lane.id))
    const override = laneFreshness(input.settings, lane.group)
    const freshness: RuleSpec = {
      id: ruleNodeId({ type: 'freshness' }),
      ref: { type: 'freshness' },
      title: 'Freshness',
      chips: [
        override.mode === 'off'
          ? 'off for this team'
          : override.mode === 'slower'
            ? `${override.factor}x slower`
            : 'sha != head, or cadence elapsed',
      ],
      enabled: override.mode !== 'off' && fresh.length > 0,
      ai: fresh.some((analyzer) => analyzer.needs.agent !== undefined),
      events: ['freshness'],
      analyzers: [],
      wildcard: { node: 'action:freshness', except: [] },
      lanes: [lane.id],
      actions: [
        {
          id: 'action:freshness',
          action: 'analyzers',
          label: fresh.length === 1 ? '1 analyzer' : `${fresh.length} analyzers`,
          ai: fresh.some((analyzer) => analyzer.needs.agent !== undefined),
        },
      ],
    }
    const release: RuleSpec = {
      id: ruleNodeId({ type: 'release' }),
      ref: { type: 'release' },
      title: 'Release assistant',
      chips: ['repositories with releases on'],
      enabled: true,
      ai: false,
      events: ['tag', 'push', 'mergeRequest'],
      analyzers: [],
      lanes: [ALL_LANE],
      actions: [{ id: 'action:release', action: 'release', label: 'Release step', ai: false }],
    }
    const laneRules = [...own, freshness, ...(lane.id === ALL_LANE ? [release] : [])]
    const events = eventOrder.filter((event) => laneRules.some((r) => r.events.includes(event)))
    const actions = new Map<string, ActionSpec>()
    for (const rule of laneRules) for (const action of rule.actions) actions.set(action.id, action)
    const nodes: AutomationNode[] = [
      ...events.map((event): AutomationNode => ({
        id: `event:${event}`,
        kind: 'event',
        data: { event, label: eventLabels[event] },
        ...sizes.event,
      })),
      ...laneRules.map(({ id, lanes: _lanes, actions: _actions, ...data }): AutomationNode => ({
        id,
        kind: 'rule',
        data,
        ...sizes.rule,
      })),
      ...[...actions.values()]
        .toSorted((a, b) => a.label.localeCompare(b.label))
        .map(({ id, ...data }): AutomationNode => ({ id, kind: 'action', data, ...sizes.action })),
    ]
    const edges: FlowEdgeSpec[] = laneRules.flatMap((rule) => [
      ...rule.events.map((event) => ({
        from: `event:${event}`,
        to: rule.id,
        ...(rule.enabled ? {} : { dashed: true }),
      })),
      ...rule.actions.map((action) => ({
        from: rule.id,
        to: action.id,
        ...(rule.enabled ? {} : { dashed: true }),
      })),
    ])
    return { ...lane, nodes, edges }
  })
}

/** Lanes a job's path can show in: every repository, then the job's config groups. */
export const jobLanes = (groups: readonly string[]): string[] => [ALL_LANE, ...groups]

/** A highlighted path: node ids and edge keys (`from->to`). */
export interface WhyPath {
  nodes: string[]
  edges: string[]
}

type JobOrigin = Pick<Job, 'trigger' | 'analyzer' | 'schedule'>

const originEvents: Partial<Record<Job['trigger'], AutomationEvent[]>> = {
  freshness: ['freshness'],
  schedule: ['schedule'],
  tag: ['tag'],
  push: ['push'],
  'new-repo': ['newRepo'],
  webhook: ['mergeRequest', 'label'],
  command: ['command'],
}

function matchesOrigin(rule: RuleData, job: JobOrigin): boolean {
  const ref = rule.ref
  switch (job.trigger) {
    case 'freshness':
      return ref.type === 'freshness'
    case 'schedule':
    case 'manual':
      return ref.type === 'schedule' && job.schedule !== undefined && ref.id === job.schedule
    case 'tag':
    case 'push':
    case 'new-repo':
      return ref.type === 'trigger' && rule.events.includes(originEvents[job.trigger]![0]!)
    case 'webhook':
    case 'command':
      return (
        (ref.type === 'trigger' || ref.type === 'policy') &&
        rule.events.some((event) => originEvents[job.trigger]!.includes(event))
      )
    default:
      return false
  }
}

/** The action node of `rule` that queues `analyzer`, if any. */
function actionFor(rule: RuleData, analyzer: string): string | undefined {
  if (rule.analyzers.includes(analyzer)) return `analyzer:${analyzer}`
  if (rule.wildcard && !rule.wildcard.except.includes(analyzer)) return rule.wildcard.node
  return undefined
}

/**
 * The event → rule → action path in `lane` that could have queued `job`: the schedule that ran
 * it (also by hand, even when disabled), the freshness rule, or the triggers and policies of its
 * event that queue its analyzer; other disabled rules never count. `undefined` when nothing in the lane explains it (a run by hand, polling, or a
 * rule changed since).
 */
export function whyPath(lane: AutomationLane, job: JobOrigin): WhyPath | undefined {
  const events = job.trigger === 'manual' ? ['schedule'] : (originEvents[job.trigger] ?? [])
  const nodes = new Set<string>()
  const edges = new Set<string>()
  for (const node of lane.nodes) {
    if (node.kind !== 'rule' || !matchesOrigin(node.data, job)) continue
    if (!node.data.enabled && job.trigger !== 'manual') continue
    const action = actionFor(node.data, job.analyzer)
    if (!action) continue
    nodes.add(node.id)
    nodes.add(action)
    edges.add(`${node.id}->${action}`)
    for (const event of node.data.events) {
      if (!events.includes(event)) continue
      nodes.add(`event:${event}`)
      edges.add(`event:${event}->${node.id}`)
    }
  }
  return nodes.size ? { nodes: [...nodes], edges: [...edges] } : undefined
}

/** When an analyzer refreshes, in a few words: `on change, at most every 6h` or `every 7d`. */
export function describeRefresh(refresh: NonNullable<JobAnalyzerView['refresh']>): string {
  const base =
    refresh.on === 'change'
      ? `on change${refresh.paths?.length ? ' of its files' : ''}, at most every ${refresh.minInterval}`
      : `every ${refresh.cadence}`
  return refresh.heavy ? `${base}, at night` : base
}

/** Limits of the freshness sweeper as stored, with the server's defaults filled in. */
export interface SweepLimits {
  maxJobsPerHour: number
  maxAiJobsPerHour: number
  nightWindow: { from: string; to: string }
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === 'number' ? value : fallback
const textOr = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)

/** The `freshness.sweep` limits from settings entries, defaults for anything unset. */
export function sweepLimits(settings: readonly SettingView[]): SweepLimits {
  const entry = settings.find((s) => s.key === FRESHNESS_SWEEP_KEY && s.scope.all && !s.secret)
  const value = isRecord(entry?.value) ? entry.value : {}
  const night = isRecord(value.nightWindow) ? value.nightWindow : {}
  return {
    maxJobsPerHour: numberOr(value.maxJobsPerHour, 10),
    maxAiJobsPerHour: numberOr(value.maxAiJobsPerHour, 2),
    nightWindow: { from: textOr(night.from, '01:00'), to: textOr(night.to, '07:00') },
  }
}
