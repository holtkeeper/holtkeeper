import type { AiUsageOverview } from '@holtkeeper/api'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight, ListChecks, Map as MapIcon, Play } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useAiOverview, useGroupTitles, useJobCount, useJobTargets } from '../../api/queries.ts'
import { canReadSpend } from '../../lib/access.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { ALL_LANE, type AutomationRule, ruleNodeId } from '../../lib/automation-flow.ts'
import {
  type AutomationSearch,
  type AutomationTab,
  type ScheduleState,
  describeCadence,
  describeTrigger,
  filterSchedules,
  inMyTeams,
  isProblem,
  laneInView,
  laneScopeCounts,
  scheduleStateLabel,
  scheduleStates,
} from '../../lib/automation.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { type ScopeView, scopeLabel, viewGroup } from '../../lib/home-scope.ts'
import { jobScopeRepos } from '../../lib/jobs.ts'
import {
  Button,
  EmptyState,
  FilterButton,
  Legend,
  OtherTeams,
  Page,
  SegmentedTabs,
  SideSheet,
  Strip,
  type StripCell,
  Switch,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { TargetActivity } from './Activity.tsx'
import {
  FreshnessAnalyzers,
  FreshnessTeams,
  FreshnessTiles,
  SweepLimitsNote,
  staleCount,
} from './freshness.tsx'
import { type AutomationModel, type PageHeader, type ScheduleRow, scheduleRows } from './model.ts'
import { RuleEditor, ruleId, ruleTarget } from './rules.tsx'
import {
  RunTicks,
  ScheduleOverview,
  runLegend,
  scheduleProgress,
  useRunNow,
  useScheduleActions,
  useToggleSchedule,
} from './schedule.tsx'
import { ScheduleForm } from './ScheduleForm.tsx'

const laneLabel = (lane: string) => (lane === ALL_LANE ? 'All repositories' : lane)

const teamTags = (lanes: readonly string[]) => (
  <span className="flex flex-wrap gap-1">
    {lanes.map((lane) => (
      <Tag key={lane}>{laneLabel(lane)}</Tag>
    ))}
  </span>
)

const matchesRule = (rule: AutomationRule, needle: string) =>
  !needle ||
  [rule.title, ruleId(rule.ref) ?? '', ...rule.chips, ...rule.analyzers].some((text) =>
    text.toLowerCase().includes(needle),
  )

function TwoLine({ top, bottom, mono }: { top: ReactNode; bottom?: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col leading-tight">
      <span className="truncate">{top}</span>
      {bottom ? (
        <small className={`truncate text-[11px] text-dim ${mono ? 'mono' : ''}`}>{bottom}</small>
      ) : null}
    </div>
  )
}

function AutomaticSpend({ overview }: { overview: AiUsageOverview | undefined }) {
  if (!overview) return <>—</>
  return (
    <span
      className="mono"
      title={`Forecast ${formatUsd(overview.forecast.automaticForecastUsd)} this week`}
    >
      {formatUsd(overview.current.automaticUsd)}
    </span>
  )
}

const DAY_MS = 86_400_000

/** Monday 00:00 UTC of the week `at` falls in. */
const utcWeekStart = (at: Date) => {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  return new Date(day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS).toISOString()
}

const stopRow = (event: { stopPropagation: () => void }) => event.stopPropagation()

const lastRunNote = (row: ScheduleRow) => {
  const run = row.runs[0]
  if (!run) return undefined
  return [
    `${run.jobs} ${run.jobs === 1 ? 'job' : 'jobs'}`,
    ...(run.failed ? [`${run.failed} failed`] : []),
    ...(run.blocked ? [`${run.blocked} blocked`] : []),
    ...(run.actor ? ['by hand'] : []),
  ].join(' · ')
}

/**
 * Ops › Automation as a list: one tab per rule kind (triggers, schedules, merge request policies,
 * freshness), filtered by the scope switch, text, team and status. A schedule opens its sheet
 * (overview, edit, activity); a trigger or policy opens its form.
 */
export function AutomationList({
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
  const { can } = useSession()
  const { view: scopeView, setView, homeGroups } = useScope()
  const [query, setQuery] = useState('')
  const [teams, setTeams] = useState<string[]>([])
  const [states, setStates] = useState<ScheduleState[]>([])
  const [problems, setProblems] = useState(false)
  const runNow = useRunNow()
  const toggle = useToggleSchedule()
  const tab: AutomationTab = search.tab ?? 'schedules'
  const needle = query.trim().toLowerCase()
  const mine = (lanes: readonly string[]) => inMyTeams(lanes, homeGroups)
  const inScope = (lanes: readonly string[]) => laneInView(lanes, scopeView, homeGroups)

  const lanes = model.lanes.map((lane) => ({ id: lane.id, label: lane.label }))
  const visibleLanes = lanes.filter((lane) => inScope([lane.id]))
  const allSchedules = scheduleRows(model)
  const filter = { q: query, teams, states, problems }
  const schedules = filterSchedules(
    allSchedules.filter((row) => inScope(row.lanes)),
    filter,
  )
  const otherSchedules =
    scopeView === 'mine'
      ? filterSchedules(
          allSchedules.filter((row) => !mine(row.lanes)),
          filter,
        )
      : []
  const ofType = (type: 'trigger' | 'policy') =>
    model.rules.filter(
      (rule) =>
        rule.ref.type === type &&
        inScope(rule.lanes) &&
        matchesRule(rule, needle) &&
        (!teams.length || rule.lanes.some((lane) => teams.includes(lane))),
    )
  const triggers = ofType('trigger')
  const policies = ofType('policy')
  const stale = staleCount(visibleLanes, model.freshness)

  const scopeCounts = (lanesOf: readonly (readonly string[])[]) =>
    laneScopeCounts(lanesOf, homeGroups)
  const counts =
    tab === 'schedules'
      ? scopeCounts(allSchedules.map((row) => row.lanes))
      : tab === 'freshness'
        ? scopeCounts(lanes.map((lane) => [lane.id]))
        : scopeCounts(
            model.rules
              .filter((rule) => rule.ref.type === (tab === 'triggers' ? 'trigger' : 'policy'))
              .map((r) => r.lanes),
          )

  const kindTabs = [
    {
      id: 'triggers' as const,
      label: (
        <>
          Triggers <span className="text-dim">{model.triggers.length}</span>
        </>
      ),
    },
    {
      id: 'schedules' as const,
      label: (
        <>
          Schedules <span className="text-dim">{model.schedules.length}</span>
        </>
      ),
    },
    {
      id: 'policies' as const,
      label: (
        <>
          MR policies{' '}
          <span className="text-dim">
            {model.rules.filter((rule) => rule.ref.type === 'policy').length}
          </span>
        </>
      ),
    },
    {
      id: 'freshness' as const,
      label: <>Freshness {stale ? <span className="text-warn">{stale} stale</span> : null}</>,
    },
  ]

  const openSchedule = allSchedules.find((row) => row.id === search.schedule)
  const openRule = model.rules.find((rule) => rule.id === search.rule)

  return (
    <Page
      {...header}
      scope={{ value: scopeView, onChange: setView, counts }}
      {...(tab === 'freshness'
        ? {}
        : {
            search: {
              value: query,
              onChange: setQuery,
              'aria-label': `Filter ${tab}`,
              placeholder: 'Filter by name, id, analyzer',
            },
          })}
      filters={
        <>
          <SegmentedTabs
            aria-label="Rule kind"
            items={kindTabs}
            selected={tab}
            onSelect={(id) => {
              const next = kindTabs.find((kind) => kind.id === id)?.id
              if (next) setSearch({ tab: next === 'schedules' ? undefined : next, rule: undefined })
            }}
          />
          {tab === 'freshness' ? null : (
            <FilterButton
              label="Team"
              options={lanes.map((lane) => ({ id: lane.id, label: lane.label }))}
              value={teams}
              onChange={setTeams}
            />
          )}
          {tab === 'schedules' ? (
            <>
              <FilterButton
                label="Status"
                options={scheduleStates.map((id) => ({ id, label: scheduleStateLabel(id) }))}
                value={states}
                onChange={(next) =>
                  setStates(scheduleStates.filter((state) => next.includes(state)))
                }
              />
              <Button
                variant={problems ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={problems}
                onPress={() => setProblems(!problems)}
              >
                Problems only
              </Button>
            </>
          ) : null}
        </>
      }
    >
      {tab === 'schedules' ? (
        <SchedulesTab
          rows={schedules}
          others={otherSchedules}
          all={allSchedules.filter((row) => inScope(row.lanes))}
          scopeView={scopeView}
          selected={search.schedule}
          onOpen={(id) => setSearch({ schedule: id, rule: undefined })}
          onRun={model.canRun ? (row) => runNow(row.id, row.name) : undefined}
          onToggle={model.writable ? (row, on) => toggle(row.entry, on) : undefined}
          showSpend={canReadSpend(can)}
        />
      ) : null}
      {tab === 'schedules' ? (
        <section className="flex flex-col gap-2" aria-label="Freshness by team">
          <header className="flex flex-wrap items-center gap-2">
            <h2 className="text-[13px] font-semibold">Freshness</h2>
            <span className="text-xs text-muted">re-runs analyzers whose results went stale</span>
            {stale ? (
              <Tag tone="warning" dot>
                {stale} stale
              </Tag>
            ) : null}
            <span className="ml-auto text-xs text-muted">
              {model.freshness?.nextAt
                ? `Next sweep ${formatRelative(model.freshness.nextAt)}, every ${model.freshness.sweepMinutes} min`
                : null}
            </span>
          </header>
          <FreshnessTeams
            lanes={visibleLanes}
            settings={model.settings}
            overview={model.freshness}
            writable={model.writable}
          />
        </section>
      ) : null}
      {tab === 'triggers' ? (
        <RulesTable
          label="Triggers"
          rules={triggers}
          selected={search.rule}
          onOpen={(id) => setSearch({ rule: id, schedule: undefined })}
          columns={[
            {
              header: 'When',
              cell: (rule) => {
                const entry = model.triggers.find(
                  (t) => rule.ref.type === 'trigger' && t.id === rule.ref.id,
                )
                return (
                  <span className="text-muted">{entry ? describeTrigger(entry.data) : ''}</span>
                )
              },
            },
          ]}
        />
      ) : null}
      {tab === 'policies' ? (
        <RulesTable
          label="Merge request policies"
          rules={policies}
          selected={search.rule}
          onOpen={(id) => setSearch({ rule: id, schedule: undefined })}
          columns={[
            {
              header: 'Conditions',
              cell: (rule) => (
                <span className="text-muted">
                  {rule.chips.join(' · ') || 'Every merge request'}
                </span>
              ),
            },
            {
              header: 'Status',
              cell: (rule) =>
                rule.enabled ? (
                  <Tag tone="success" dot>
                    On
                  </Tag>
                ) : (
                  <Tag dot>Off</Tag>
                ),
            },
          ]}
        />
      ) : null}
      {tab === 'freshness' ? <FreshnessTab model={model} lanes={visibleLanes} /> : null}
      <footer className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <SweepLimitsNote settings={model.settings} />
      </footer>
      <ScheduleSheet
        row={openSchedule}
        rows={schedules}
        model={model}
        onOpen={(id) => setSearch({ schedule: id })}
        onClose={() => setSearch({ schedule: undefined })}
        onMap={(row) =>
          setSearch({
            view: 'map',
            schedule: undefined,
            rule: ruleNodeId({ type: 'schedule', id: row.id }),
            lane: row.lanes.find((lane) => lane !== ALL_LANE),
          })
        }
      />
      <RuleSheet
        rule={openRule && openRule.ref.type !== 'schedule' ? openRule : undefined}
        rules={tab === 'policies' ? policies : triggers}
        model={model}
        onOpen={(id) => setSearch({ rule: id })}
        onClose={() => setSearch({ rule: undefined })}
      />
    </Page>
  )
}

function SchedulesTab({
  rows,
  others,
  all,
  scopeView,
  selected,
  onOpen,
  onRun,
  onToggle,
  showSpend,
}: {
  rows: readonly ScheduleRow[]
  others: readonly ScheduleRow[]
  /** Every schedule in scope, before the text and status filters, for the strip. */
  all: readonly ScheduleRow[]
  scopeView: ScopeView
  selected: string | undefined
  onOpen: (id: string) => void
  onRun: ((row: ScheduleRow) => void) | undefined
  onToggle: ((row: ScheduleRow, on: boolean) => void) | undefined
  showSpend: boolean
}) {
  const titleOf = useGroupTitles()
  const now = new Date()
  const { homeGroups } = useScope()
  const targets = useJobTargets()
  const overview = useAiOverview(showSpend, { period: 'week' })
  const repos = jobScopeRepos(scopeView, targets.data?.targets, homeGroups)
  const weekFrom = overview.data?.current.from ?? utcWeekStart(now)
  const jobCount = useJobCount(
    { trigger: 'schedule', since: weekFrom, ...(repos && { repos }) },
    (scopeView === 'all' || targets.isSuccess) && (!showSpend || !overview.isPending),
  )
  const enabled = all.filter((row) => row.entry.data.enabled)
  const nextRow = enabled
    .filter((row) => row.next[0] !== undefined)
    .toSorted((a, b) => (a.next[0] ?? '').localeCompare(b.next[0] ?? ''))[0]
  const stateCount = (state: ScheduleState) =>
    all.filter((row) => row.health.state === state).length
  const cells: StripCell[] = [
    { value: all.length, label: all.length === 1 ? 'schedule' : 'schedules' },
    { value: enabled.length, label: 'enabled', caption: `· ${all.length - enabled.length} paused` },
    ...(nextRow?.next[0]
      ? [
          {
            prefix: 'Next run',
            value: formatRelative(nextRow.next[0], now),
            label: <span className="mono">{nextRow.id}</span>,
          },
        ]
      : []),
    { value: jobCount.data?.total ?? '—', label: 'scheduled jobs this week' },
    ...(showSpend
      ? [
          {
            prefix: 'Automatic AI this week',
            value: <AutomaticSpend overview={overview.data} />,
            label: (
              <Link to="/ops/spend" className="hover:text-foreground hover:underline">
                forecast in AI spend
              </Link>
            ),
          },
        ]
      : []),
    ...(['failing', 'blocked', 'partial'] as const)
      .filter((state) => stateCount(state) > 0)
      .map((state, index) => ({
        value: stateCount(state),
        label: scheduleStateLabel(state).toLowerCase(),
        tone:
          state === 'failing'
            ? ('danger' as const)
            : state === 'blocked'
              ? ('code' as const)
              : ('warning' as const),
        end: index === 0,
      })),
    {
      value: stateCount('healthy'),
      label: 'healthy',
      tone: 'success',
      ...(all.some((row) => isProblem(row.health.state)) ? {} : { end: true }),
    },
  ]
  const header = (
    <tr>
      <Th>Schedule</Th>
      <Th>Cadence</Th>
      <Th>Team</Th>
      <Th>Analyzers</Th>
      <Th>Last 14 runs</Th>
      <Th>Status</Th>
      <Th>Last run</Th>
      <Th>Next run</Th>
      <Th>On</Th>
      <Th>
        <span className="sr-only">Run</span>
      </Th>
    </tr>
  )
  const row = (item: ScheduleRow) => {
    const data = item.entry.data
    const last = item.runs[0]
    return (
      <Tr key={item.id} selected={item.id === selected} onClick={() => onOpen(item.id)}>
        <Td>
          <TwoLine top={<span className="font-medium">{item.name}</span>} bottom={item.id} mono />
        </Td>
        <Td>
          <TwoLine
            top={<span className="mono">{data.cron ?? data.every}</span>}
            bottom={
              data.timezone ? `${describeCadence(data)} · ${data.timezone}` : describeCadence(data)
            }
          />
        </Td>
        <Td>{teamTags(item.lanes)}</Td>
        <Td>
          <span className="flex items-center gap-1.5">
            <span className="mono truncate text-muted">{item.analyzers.join(', ')}</span>
            {item.ai ? <Tag tone="code">AI</Tag> : null}
          </span>
        </Td>
        <Td>
          <RunTicks row={item} count={14} className="w-28" />
        </Td>
        <Td>
          <Tag tone={item.health.tone} dot>
            {item.health.label}
          </Tag>
        </Td>
        <Td className="whitespace-nowrap">
          {last ? (
            <TwoLine
              top={<span title={formatDateTime(last.at)}>{formatRelative(last.at, now)}</span>}
              bottom={lastRunNote(item)}
            />
          ) : (
            <span className="text-dim">Never</span>
          )}
        </Td>
        <Td className="whitespace-nowrap text-muted">
          {!data.enabled ? 'Paused' : item.next[0] ? formatRelative(item.next[0], now) : '—'}
        </Td>
        <Td onClick={stopRow}>
          {onToggle ? (
            <Switch
              label={<span className="sr-only">Enable {item.name}</span>}
              isSelected={data.enabled}
              onChange={(on) => onToggle(item, on)}
            />
          ) : (
            <span className="text-muted">{data.enabled ? 'On' : 'Off'}</span>
          )}
        </Td>
        <Td onClick={stopRow}>
          {onRun ? (
            <Button
              isIconOnly
              variant="ghost"
              size="sm"
              aria-label={`Run ${item.name} now`}
              onPress={() => onRun(item)}
            >
              <Play className="size-3.5" />
            </Button>
          ) : null}
        </Td>
      </Tr>
    )
  }
  return (
    <section className="flex flex-col gap-2" aria-label="Schedules">
      <Strip cells={cells} label="Schedules summary" className="-mx-4 -mt-4" />
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">Schedules</h2>
        <span className="text-xs text-muted">
          {viewGroup(scopeView) !== undefined
            ? scopeLabel(scopeView, titleOf)
            : scopeLabel(scopeView).toLowerCase()}{' '}
          · worst first
        </span>
        <Legend items={runLegend} label="Run legend" className="ml-auto" />
      </header>
      {rows.length || others.length ? (
        <Table label="Schedules">
          <thead>{header}</thead>
          <tbody>
            {rows.map(row)}
            <OtherTeams
              variant="row"
              colSpan={10}
              count={others.length}
              teams={[...new Set(others.flatMap((item) => item.lanes))].toSorted()}
              noun={{ one: 'schedule' }}
            >
              {others.map(row)}
            </OtherTeams>
          </tbody>
        </Table>
      ) : (
        <EmptyState icon={<ListChecks />} title="No schedule matches" />
      )}
    </section>
  )
}

interface RuleColumn {
  header: string
  cell: (rule: AutomationRule) => ReactNode
}

function RulesTable({
  label,
  rules,
  selected,
  onOpen,
  columns,
}: {
  label: string
  rules: readonly AutomationRule[]
  selected: string | undefined
  onOpen: (id: string) => void
  columns: readonly RuleColumn[]
}) {
  if (!rules.length)
    return <EmptyState icon={<ListChecks />} title={`No ${label.toLowerCase()} match`} />
  return (
    <Table label={label}>
      <thead>
        <tr>
          <Th>Rule</Th>
          {columns.map((column) => (
            <Th key={column.header}>{column.header}</Th>
          ))}
          <Th>Team</Th>
          <Th>Then</Th>
          <Th>
            <span className="sr-only">Open</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => (
          <Tr key={rule.id} selected={rule.id === selected} onClick={() => onOpen(rule.id)}>
            <Td>
              <TwoLine
                top={<span className="font-medium">{rule.title}</span>}
                bottom={ruleId(rule.ref)}
                mono
              />
            </Td>
            {columns.map((column) => (
              <Td key={column.header}>{column.cell(rule)}</Td>
            ))}
            <Td>{teamTags(rule.lanes)}</Td>
            <Td>
              <span className="flex flex-wrap items-center gap-1">
                {rule.actions.map((action) => (
                  <Tag key={action.id} {...(action.ai ? { tone: 'code' as const } : {})}>
                    {action.label}
                  </Tag>
                ))}
              </span>
            </Td>
            <Td align="right">
              <ChevronRight className="size-4 text-muted" aria-hidden />
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

function FreshnessTab({
  model,
  lanes,
}: {
  model: AutomationModel
  lanes: readonly { id: string; label: string }[]
}) {
  const [team, setTeam] = useState<string>()
  const picked = lanes.find((lane) => lane.id === team) ?? lanes[0]
  return (
    <>
      <FreshnessTiles lanes={lanes} overview={model.freshness} />
      <FreshnessTeams
        lanes={lanes}
        settings={model.settings}
        overview={model.freshness}
        writable={model.writable}
      />
      {picked ? (
        <section className="flex flex-col gap-2" aria-label="Analyzers kept fresh">
          <header className="flex flex-wrap items-center gap-2">
            <h2 className="text-[13px] font-semibold">Analyzers</h2>
            <span className="text-xs text-muted">what each refreshes on, and the last sweep</span>
            {lanes.length > 1 ? (
              <SegmentedTabs
                aria-label="Team"
                items={lanes.map((lane) => ({ id: lane.id, label: lane.label }))}
                selected={picked.id}
                onSelect={setTeam}
              />
            ) : null}
          </header>
          <FreshnessAnalyzers
            group={picked.id === ALL_LANE ? undefined : picked.id}
            analyzers={model.analyzers}
            overview={model.freshness}
          />
        </section>
      ) : null}
    </>
  )
}

type SheetTab = 'overview' | 'edit' | 'activity'

function ScheduleSheet({
  row,
  rows,
  model,
  onOpen,
  onClose,
  onMap,
}: {
  row: ScheduleRow | undefined
  rows: readonly ScheduleRow[]
  model: AutomationModel
  onOpen: (id: string) => void
  onClose: () => void
  onMap: (row: ScheduleRow) => void
}) {
  const [state, setState] = useState<{ id?: string; tab: SheetTab }>({ tab: 'overview' })
  const tab = state.id === row?.id ? state.tab : 'overview'
  const setTab = (next: SheetTab) => setState({ ...(row && { id: row.id }), tab: next })
  const actions = useScheduleActions(row, model)
  const navigate = useNavigate()
  const step = neighbours(
    rows.map((r) => r.id),
    row?.id,
  )
  const progress = row ? scheduleProgress(row) : undefined
  return (
    <SideSheet
      open={row !== undefined}
      onClose={onClose}
      title={
        row ? (
          <span className="flex flex-wrap items-center gap-2">
            {row.name}
            <Tag tone={row.health.tone} dot>
              {row.health.label}
            </Tag>
          </span>
        ) : (
          ''
        )
      }
      {...(row ? { id: row.id, copyId: row.id } : {})}
      {...(step.index >= 0 ? { index: step.index, total: rows.length } : {})}
      {...(step.previous ? { onPrevious: () => onOpen(step.previous!) } : {})}
      {...(step.next ? { onNext: () => onOpen(step.next!) } : {})}
      {...(progress ? { progress } : {})}
      {...(actions ? { quietActions: actions } : {})}
      {...(row
        ? {
            more: [
              {
                label: 'Show runs',
                icon: ListChecks,
                onAction: () => void navigate({ to: '/ops/runs', search: { schedule: row.id } }),
              },
              { label: 'Show on map', icon: MapIcon, onAction: () => onMap(row) },
            ],
          }
        : {})}
      tabs={{
        items: [
          { id: 'overview', label: 'Overview' },
          { id: 'edit', label: 'Edit rule' },
          { id: 'activity', label: 'Activity' },
        ],
        selected: tab,
        onSelect: (id) => {
          if (id === 'overview' || id === 'edit' || id === 'activity') setTab(id)
        },
        'aria-label': 'Schedule details',
      }}
    >
      {row ? (
        tab === 'edit' ? (
          <ScheduleForm
            key={row.id}
            entry={row.entry}
            taken={model.schedules.map((s) => s.id)}
            writable={model.writable}
            onDone={() => setTab('overview')}
          />
        ) : tab === 'activity' ? (
          <TargetActivity type="schedule" id={row.id} />
        ) : (
          <ScheduleOverview row={row} />
        )
      ) : null}
    </SideSheet>
  )
}

function RuleSheet({
  rule,
  rules,
  model,
  onOpen,
  onClose,
}: {
  rule: AutomationRule | undefined
  rules: readonly AutomationRule[]
  model: AutomationModel
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [state, setState] = useState<{ id?: string; tab: 'rule' | 'activity' }>({ tab: 'rule' })
  const tab = state.id === rule?.id ? state.tab : 'rule'
  const target = rule ? ruleTarget(rule.ref) : undefined
  const step = neighbours(
    rules.map((r) => r.id),
    rule?.id,
  )
  const id = rule ? ruleId(rule.ref) : undefined
  return (
    <SideSheet
      open={rule !== undefined}
      onClose={onClose}
      title={rule?.title ?? ''}
      {...(id ? { id } : {})}
      {...(step.index >= 0 ? { index: step.index, total: rules.length } : {})}
      {...(step.previous ? { onPrevious: () => onOpen(step.previous!) } : {})}
      {...(step.next ? { onNext: () => onOpen(step.next!) } : {})}
      {...(target
        ? {
            tabs: {
              items: [
                { id: 'rule', label: 'Rule' },
                { id: 'activity', label: 'Activity' },
              ],
              selected: tab,
              onSelect: (next: string) =>
                setState({
                  ...(rule && { id: rule.id }),
                  tab: next === 'activity' ? 'activity' : 'rule',
                }),
              'aria-label': 'Rule details',
            },
          }
        : {})}
    >
      {rule ? (
        tab === 'activity' && target ? (
          <TargetActivity type={target.type} id={target.id} />
        ) : (
          <RuleEditor key={rule.id} rule={rule.ref} model={model} onDone={onClose} />
        )
      ) : null}
    </SideSheet>
  )
}
