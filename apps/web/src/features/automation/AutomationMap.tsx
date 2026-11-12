import { Link } from '@tanstack/react-router'
import { List } from 'lucide-react'
import { useState } from 'react'

import { useJob, useJobTargets, useJobWhy } from '../../api/queries.ts'
import {
  ALL_LANE,
  type AutomationNode,
  type RuleKind,
  type RuleRef,
  filterLane,
  jobLanes,
  laneRuleCounts,
  mergedLane,
  ruleKinds,
  whyPath,
} from '../../lib/automation-flow.ts'
import { type AutomationSearch, isProblem } from '../../lib/automation.ts'
import { shortId } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  FilterButton,
  FlowCanvas,
  type FlowDrawer,
  Legend,
  Page,
  SegmentedTabs,
} from '../../ui/index.ts'
import { TargetActivity } from './Activity.tsx'
import { staleCount } from './freshness.tsx'
import { type AutomationModel, type PageHeader, scheduleRows } from './model.ts'
import { type RuleBadge, automationNodeRenderer } from './nodes.tsx'
import { RuleEditor, ruleId, ruleTarget } from './rules.tsx'
import { ScheduleOverview, scheduleProgress, useScheduleActions } from './schedule.tsx'

type DrawerTab = 'rule' | 'health' | 'activity'

const mapLegend = [
  { label: 'enabled', color: 'var(--line-strong)' },
  { label: 'rule off (dashed)', tone: 'none' as const },
  { label: 'path of a job', tone: 'accent' as const },
  { label: 'AI: calls a model, budget permitting', tone: 'code' as const },
]

function WhyNotice({
  jobId,
  status,
  found,
  onClear,
}: {
  jobId: string
  status: string | undefined
  found: boolean
  onClear: () => void
}) {
  const why = useJobWhy(jobId, status ?? 'succeeded')
  return (
    <div className="flex max-w-xl flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
      <span
        className={`size-2 shrink-0 rounded-full ${found ? 'bg-accent' : 'bg-[var(--line-strong)]'}`}
      />
      <span className="min-w-0 flex-1">
        Why job <span className="mono">{shortId(jobId)}</span> ran:{' '}
        <span className="text-muted">
          {why.data?.origin ?? 'Loading…'}
          {why.data && !found ? '. No rule on this map queued it.' : ''}
        </span>
      </span>
      <Link
        to="/ops/runs/$jobId"
        params={{ jobId }}
        className="text-muted hover:text-foreground hover:underline"
      >
        Open job
      </Link>
      <Button variant="ghost" size="sm" onPress={onClear}>
        Clear
      </Button>
    </div>
  )
}

/**
 * Ops › Automation as a map: one canvas of a team's events → rules → actions merged with the rules
 * that cover every repository, filtered by kind, AI and text. Rules carry their kind or a status
 * badge (a failing schedule, stale freshness); clicking one opens its form in the drawer, a
 * schedule also its health and activity. `?job=` highlights the path that queued that job.
 */
export function AutomationMap({
  model,
  header,
  search,
  setSearch,
}: {
  model: AutomationModel
  header: PageHeader
  search: AutomationSearch
  setSearch: (patch: Partial<AutomationSearch>) => void
}) {
  const [kinds, setKinds] = useState<RuleKind[]>([])
  const [aiOnly, setAiOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [drawerTab, setDrawerTab] = useState<{ id?: string; tab: DrawerTab }>({ tab: 'rule' })
  const job = useJob(search.job)
  const targets = useJobTargets()

  const jobGroups = job.data
    ? job.data.group !== undefined
      ? [job.data.group]
      : (targets.data?.targets.find((t) => t.repo === repoKey(job.data.repo))?.groups ?? [])
    : []
  const jobLane = job.data
    ? jobLanes(jobGroups)
        .toReversed()
        .find((id) => {
          const lane = mergedLane(model.lanes, id)
          return lane.id === id && whyPath(lane, job.data) !== undefined
        })
    : undefined
  const laneId = model.lanes.some((lane) => lane.id === search.lane)
    ? (search.lane ?? ALL_LANE)
    : (jobLane ?? ALL_LANE)
  const merged = mergedLane(model.lanes, laneId)
  const lane = filterLane(merged, { kinds, ai: aiOnly, query })
  const path = job.data ? whyPath(merged, job.data) : undefined
  const edges = path
    ? lane.edges.map((edge) =>
        path.edges.includes(`${edge.from}->${edge.to}`)
          ? { ...edge, tone: 'accent' as const }
          : edge,
      )
    : lane.edges
  const counts = laneRuleCounts(model.lanes)

  const schedules = scheduleRows(model)
  const stale = staleCount([{ id: laneId }], model.freshness)
  const badgeOf = (ref: RuleRef): RuleBadge | undefined => {
    if (ref.type === 'schedule') {
      const health = schedules.find((row) => row.id === ref.id)?.health
      return health && isProblem(health.state)
        ? { label: health.label, tone: health.tone }
        : undefined
    }
    if (ref.type === 'freshness' && stale) return { label: `${stale} stale`, tone: 'warning' }
    return undefined
  }

  const openNode = lane.nodes.find((node) => node.id === search.rule)
  const openRef = openNode?.kind === 'rule' ? openNode.data.ref : undefined
  const openSchedule =
    openRef?.type === 'schedule' ? schedules.find((row) => row.id === openRef.id) : undefined
  const scheduleActions = useScheduleActions(openSchedule, model)
  const tab = drawerTab.id === search.rule ? drawerTab.tab : 'rule'

  const drawer = (node: AutomationNode): FlowDrawer | undefined => {
    if (node.kind !== 'rule') return undefined
    const ref = node.data.ref
    const target = ruleTarget(ref)
    const row = ref.type === 'schedule' ? schedules.find((r) => r.id === ref.id) : undefined
    const id = ruleId(ref)
    const items = [
      { id: 'rule', label: 'Rule' },
      ...(row ? [{ id: 'health', label: 'Health' }] : []),
      ...(target ? [{ id: 'activity', label: 'Activity' }] : []),
    ]
    const shown = items.some((item) => item.id === tab) ? tab : 'rule'
    const progress = row ? scheduleProgress(row) : undefined
    return {
      title: node.data.title,
      ...(id !== undefined ? { id } : {}),
      ...(progress ? { progress } : {}),
      ...(row && scheduleActions && openSchedule?.id === row.id
        ? { quietActions: scheduleActions }
        : {}),
      ...(row
        ? {
            more: [
              {
                label: 'Open in the schedules list',
                icon: List,
                onAction: () =>
                  setSearch({
                    view: undefined,
                    rule: undefined,
                    lane: undefined,
                    schedule: row.id,
                  }),
              },
            ],
          }
        : {}),
      ...(items.length > 1
        ? {
            tabs: {
              items,
              selected: shown,
              onSelect: (next: string) =>
                setDrawerTab({
                  id: node.id,
                  tab: next === 'health' || next === 'activity' ? next : 'rule',
                }),
              'aria-label': 'Rule inspector',
            },
          }
        : {}),
      content:
        shown === 'health' && row ? (
          <ScheduleOverview row={row} />
        ) : shown === 'activity' && target ? (
          <TargetActivity type={target.type} id={target.id} />
        ) : (
          <RuleEditor
            rule={ref}
            model={model}
            group={merged.group}
            onDone={() => setSearch({ rule: undefined })}
          />
        ),
    }
  }

  return (
    <Page
      {...header}
      search={{
        value: query,
        onChange: setQuery,
        'aria-label': 'Find a node',
        placeholder: 'Find event, rule or action',
      }}
      filters={
        <>
          <SegmentedTabs
            aria-label="Team lane"
            items={model.lanes.map((item) => ({
              id: item.id,
              label: (
                <>
                  {item.label} <span className="text-dim">{counts[item.id] ?? 0}</span>
                </>
              ),
            }))}
            selected={laneId}
            onSelect={(next) =>
              setSearch({ lane: next === ALL_LANE ? undefined : next, rule: undefined })
            }
          />
          <FilterButton
            label="Kinds"
            all="All"
            options={ruleKinds}
            value={kinds}
            onChange={(next) =>
              setKinds(ruleKinds.flatMap((k) => (next.includes(k.id) ? [k.id] : [])))
            }
          />
          <Button
            variant={aiOnly ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={aiOnly}
            onPress={() => setAiOnly(!aiOnly)}
          >
            Calls AI only
          </Button>
          <span className="ml-auto text-xs text-muted">
            {laneId === ALL_LANE
              ? 'Showing the rules that cover every repository'
              : `Showing ${merged.label} and the rules that cover every repository`}
          </span>
        </>
      }
    >
      <FlowCanvas
        key={`${laneId}|${kinds.join()}|${aiOnly}|${query}`}
        aria-label={`Automation map for ${merged.label}`}
        nodes={lane.nodes}
        edges={edges}
        render={automationNodeRenderer(badgeOf)}
        drawer={drawer}
        openId={search.rule}
        onOpenChange={(id) => setSearch({ rule: id })}
        maxHeight={760}
        controls
        legend={<Legend items={mapLegend} label="Map legend" />}
        {...(path ? { highlight: new Set(path.nodes) } : {})}
        {...(search.job
          ? {
              overlay: (
                <WhyNotice
                  jobId={search.job}
                  status={job.data?.status}
                  found={path !== undefined}
                  onClear={() => setSearch({ job: undefined, view: 'map' })}
                />
              ),
            }
          : {})}
      />
    </Page>
  )
}
