import type { SettingList } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { History, Play, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  useConfigEntries,
  useGroups,
  useJobAnalyzers,
  useJobs,
  useSettings,
} from '../../../api/queries.ts'
import { useAnalyzerHealth } from '../../../api/settings-analyzers.ts'
import {
  type AnalyzerArea,
  type AnalyzerRow,
  type AnalyzerState,
  analyzerAreas,
  analyzerCounts,
  analyzerRows,
  analyzerSettingKey,
  analyzerStateLabel,
  filterAnalyzerRows,
  healthSummary,
  isOverride,
  needsLook,
} from '../../../lib/analyzer-catalog.ts'
import { automationRules } from '../../../lib/automation-flow.ts'
import { neighbours } from '../../../lib/flow.ts'
import { formatDuration, formatRelative, plural } from '../../../lib/format.ts'
import { jobStatusLabel, jobStatusTone } from '../../../lib/jobs.ts'
import { definitionsOf } from '../../../lib/settings-sections.ts'
import {
  EmptyState,
  ErrorState,
  FilterButton,
  KeyValue,
  Placeholder,
  SearchInput,
  SegmentedTabs,
  SideSheet,
  Strip,
  type StripCell,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../../ui/index.ts'
import { useRunJob } from '../../jobs/RunJobDialog.tsx'
import { useSession } from '../../shell/session.ts'
import { useSectionHeader } from '../section-header.ts'
import { SettingEntries } from '../SettingEntries.tsx'

const stateTone: Record<AnalyzerState, 'success' | 'info' | 'default'> = {
  on: 'success',
  some: 'info',
  off: 'default',
}

const stateIds: readonly (AnalyzerState | 'all')[] = ['all', 'on', 'some', 'off']

const sheetTabs = [
  { id: 'runs', label: 'Runs' },
  { id: 'options', label: 'Options' },
  { id: 'overrides', label: 'Overrides' },
] as const

type SheetTab = (typeof sheetTabs)[number]['id']

const parseTab = (tab: string | undefined): SheetTab =>
  sheetTabs.find((candidate) => candidate.id === tab)?.id ?? 'runs'

function AnalyzerRuns({ kind }: { kind: string }) {
  const jobs = useJobs({ analyzer: kind }, true, 20)
  if (jobs.isPending) return <Placeholder className="h-32" />
  if (jobs.isError) return <ErrorState error={jobs.error} />
  const list = jobs.data.pages.flatMap((page) => page.jobs)
  if (!list.length)
    return <EmptyState title="No runs yet" description="Runs you may read show up here." />
  return (
    <div className="flex flex-col gap-2">
      <Table label="Recent runs">
        <thead>
          <tr>
            <Th>Repository</Th>
            <Th>Status</Th>
            <Th align="right">Started</Th>
          </tr>
        </thead>
        <tbody>
          {list.map((job) => (
            <Tr key={job.id}>
              <Td>
                <Link
                  to="/ops/runs/$jobId"
                  params={{ jobId: job.id }}
                  className="mono text-[12.5px] hover:underline"
                >
                  {job.group ?? job.repo.path}
                </Link>
              </Td>
              <Td>
                <Tag tone={jobStatusTone(job.status)} dot>
                  {jobStatusLabel(job.status)}
                </Tag>
              </Td>
              <Td align="right">
                <span className="text-xs text-muted">{formatRelative(job.createdAt)}</span>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <Link
        to="/ops/runs"
        search={{ analyzer: kind }}
        className="text-xs text-muted hover:text-foreground"
      >
        Every run of this analyzer in Ops › Runs
      </Link>
    </div>
  )
}

/** The page drawer's option editor: every entry of `analyzers.<kind>`, or only narrower ones. */
function AnalyzerOptions({
  kind,
  data,
  overridesOnly,
}: {
  kind: string
  data: SettingList
  overridesOnly: boolean
}) {
  const [definition] = definitionsOf(data.definitions, [analyzerSettingKey(kind)])
  if (!definition)
    return (
      <EmptyState
        title="No options"
        description="This analyzer has no options; what it runs on is set in Automation."
      />
    )
  const entries = data.settings.filter(
    (entry) => entry.key === definition.key && (!overridesOnly || isOverride(entry)),
  )
  return (
    <SettingEntries
      data={data}
      definition={definition}
      entries={entries}
      {...(overridesOnly
        ? {
            initialScope: { groups: [] },
            empty: 'No repository or group overrides this analyzer’s options.',
          }
        : {})}
    />
  )
}

function AnalyzerSheet({
  row,
  rows,
  tab,
  settings,
  settingsError,
  onSelect,
  onTab,
  onClose,
}: {
  row: AnalyzerRow
  rows: readonly AnalyzerRow[]
  tab: SheetTab
  settings: SettingList | undefined
  settingsError: Error | null
  onSelect: (kind: string) => void
  onTab: (tab: SheetTab) => void
  onClose: () => void
}) {
  const step = neighbours(
    rows.map((candidate) => candidate.kind),
    row.kind,
  )
  const health = healthSummary(row.health)
  const run = useRunJob({ analyzer: row.kind, label: 'Run now' })
  const runNow = run.action?.onPress
  return (
    <SideSheet
      open
      onClose={onClose}
      id={row.kind}
      title={row.label}
      {...(runNow && {
        quietActions: [{ label: 'Run now', icon: Play, onPress: runNow }] as const,
      })}
      more={[
        {
          label: 'Show runs',
          icon: History,
          href: `/ops/runs?analyzer=${encodeURIComponent(row.kind)}`,
        },
      ]}
      {...(step.index >= 0 ? { index: step.index, total: rows.length } : {})}
      {...(step.previous ? { onPrevious: () => onSelect(step.previous!) } : {})}
      {...(step.next ? { onNext: () => onSelect(step.next!) } : {})}
      tabs={{
        items: sheetTabs.map((item) =>
          item.id === 'overrides' ? { ...item, badge: row.overrides } : item,
        ),
        selected: tab,
        onSelect: (id) => onTab(parseTab(id)),
        'aria-label': 'Analyzer',
      }}
    >
      {run.dialog}
      <div className="flex flex-col gap-4">
        <KeyValue
          rows={[
            {
              label: 'State',
              value: (
                <Tag tone={stateTone[row.state]} dot>
                  {analyzerStateLabel[row.state]}
                </Tag>
              ),
            },
            { label: 'Runs on', value: row.where },
            { label: 'Runs when', value: row.when.join(' · ') || 'When someone starts it' },
            {
              label: 'Last 7 days',
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  <Tag tone={health.tone}>{health.text}</Tag>
                  {row.health?.medianDurationMs !== undefined ? (
                    <span className="mono text-xs text-muted">
                      median {formatDuration(row.health.medianDurationMs)}
                    </span>
                  ) : null}
                </span>
              ),
            },
            ...(row.ai
              ? [{ label: 'AI', value: 'Calls an AI model; counts toward the budget' }]
              : []),
          ]}
        />
        <p className="text-xs text-muted">
          What makes it run lives in{' '}
          <Link to="/ops/automation" className="underline">
            Ops › Automation
          </Link>
          . Turning an analyzer off there keeps its records.
        </p>
        {tab === 'runs' ? (
          <AnalyzerRuns kind={row.kind} />
        ) : settingsError ? (
          <ErrorState error={settingsError} />
        ) : !settings ? (
          <Placeholder className="h-32" />
        ) : (
          <AnalyzerOptions kind={row.kind} data={settings} overridesOnly={tab === 'overrides'} />
        )}
      </div>
    </SideSheet>
  )
}

function AnalyzerTable({
  rows,
  selected,
  onOpen,
}: {
  rows: readonly AnalyzerRow[]
  selected: string | undefined
  onOpen: (kind: string) => void
}) {
  return (
    <Table label="Analyzers">
      <thead>
        <tr>
          <Th>Analyzer</Th>
          <Th>State</Th>
          <Th>Scope · runs when</Th>
          <Th>Last 7 days</Th>
          <Th align="right">Overrides</Th>
        </tr>
      </thead>
      {analyzerAreas.map((area) => {
        const members = rows.filter((row) => row.area === area.id)
        if (!members.length) return null
        return (
          <tbody key={area.id}>
            <tr>
              <td colSpan={5} className="px-3 pb-1 pt-3 text-xs text-muted">
                <span className="font-semibold text-foreground">{area.label}</span> · feeds{' '}
                {area.feeds}
              </td>
            </tr>
            {members.map((row) => {
              const health = healthSummary(row.health)
              return (
                <Tr
                  key={row.kind}
                  selected={row.kind === selected}
                  onClick={() => onOpen(row.kind)}
                >
                  <Td>
                    <div className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 font-medium">
                        {row.label}
                        {row.ai ? (
                          <Tag tone="code">
                            <Sparkles className="size-3" aria-hidden="true" />
                            AI
                          </Tag>
                        ) : null}
                      </span>
                      <span className="mono text-xs text-muted">{row.kind}</span>
                    </div>
                  </Td>
                  <Td>
                    <Tag tone={stateTone[row.state]} dot>
                      {analyzerStateLabel[row.state]}
                    </Tag>
                  </Td>
                  <Td>
                    <div className="flex min-w-0 flex-col">
                      <span>{row.where}</span>
                      <span className="truncate text-xs text-muted">
                        {row.when.join(' · ') || 'When someone starts it'}
                      </span>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col">
                      <Tag tone={health.tone}>{health.text}</Tag>
                      {row.health?.targets ? (
                        <span className="text-xs text-muted">
                          {plural(
                            row.health.targets,
                            row.scope === 'group' ? 'group' : 'repository',
                            row.scope === 'group' ? 'groups' : 'repositories',
                          )}
                        </span>
                      ) : null}
                    </div>
                  </Td>
                  <Td align="right">
                    <span className="tabular">{row.overrides || '—'}</span>
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        )
      })}
    </Table>
  )
}

const areaOptions = analyzerAreas.map((area) => ({ id: area.id, label: area.label }))

/**
 * Settings › Analyzers: every analyzer grouped by the workspace it feeds, with its state read from
 * Automation, where and when it runs, how its runs went over seven days and how many narrower
 * entries override its options. A row opens a sheet with Runs, Options (the page drawers' editor
 * for `analyzers.<kind>`) and Overrides; `?item=<kind>&tab=` keep it in the URL.
 */
export function AnalyzersSection() {
  const { can, canGlobal } = useSession()
  const search = useSearch({ from: '/app/settings/$section' })
  const navigate = useNavigate()
  const automation = canGlobal('settings:read')
  const analyzers = useJobAnalyzers()
  const health = useAnalyzerHealth(can('analyses:read'))
  const settings = useSettings(can('settings:read'))
  const triggers = useConfigEntries('triggers', automation)
  const schedules = useConfigEntries('schedules', automation)
  const groups = useGroups(automation)
  const [state, setState] = useState<AnalyzerState | 'all'>('all')
  const [areas, setAreas] = useState<AnalyzerArea[]>([])
  const [ai, setAi] = useState<string[]>([])
  const [q, setQ] = useState('')
  const runAny = useRunJob({ label: 'Run analyzer…' })
  const runAnyPress = runAny.action?.onPress
  useSectionHeader(
    runAnyPress
      ? { primary: { label: 'Run analyzer…', icon: Play, onPress: runAnyPress } }
      : undefined,
  )

  const rows = useMemo(() => {
    if (!analyzers.data) return []
    const entries = settings.data?.settings ?? []
    const rules = automation
      ? automationRules({
          groups: (groups.data?.entries ?? []).map((group) => group.id),
          triggers: triggers.data?.entries ?? [],
          schedules: schedules.data?.entries ?? [],
          settings: entries,
          analyzers: analyzers.data.analyzers,
        })
      : []
    return analyzerRows({
      analyzers: analyzers.data.analyzers,
      rules,
      settings: entries,
      ...(health.data && { health: health.data.analyzers }),
    })
  }, [
    analyzers.data,
    settings.data,
    triggers.data,
    schedules.data,
    groups.data,
    health.data,
    automation,
  ])

  const open = (patch: { item?: string | undefined; tab?: string | undefined }) =>
    void navigate({
      to: '/settings/$section',
      params: { section: 'analyzers' },
      search: (previous) => ({ ...previous, ...patch }),
      replace: true,
    })

  if (analyzers.isError) return <ErrorState error={analyzers.error} />
  if (!analyzers.data) return <Placeholder className="h-96" />

  const counts = analyzerCounts(rows)
  const shown = filterAnalyzerRows(rows, {
    ...(state !== 'all' && { state }),
    areas,
    ...(ai.length === 1 && { ai: ai[0] === 'yes' ? 'yes' : 'no' }),
    q,
  })
  const current = rows.find((row) => row.kind === search.item)
  const fleet = health.data?.analyzers ?? []
  const lastRun = fleet
    .flatMap((entry) => (entry.lastRunAt ? [entry.lastRunAt] : []))
    .toSorted((a, b) => b.localeCompare(a))[0]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs
          aria-label="State"
          selected={state}
          onSelect={(id) => setState(stateIds.find((candidate) => candidate === id) ?? 'all')}
          items={[
            { id: 'all', label: `All ${counts.all}` },
            { id: 'on', label: `On ${counts.on}` },
            { id: 'some', label: `Some repositories ${counts.some}` },
            { id: 'off', label: `Off ${counts.off}` },
          ]}
        />
        <SearchInput
          aria-label="Search analyzers"
          placeholder="Search analyzers"
          value={q}
          onChange={setQ}
          className="min-w-48 flex-1"
        />
        <FilterButton
          label="Area"
          options={areaOptions}
          value={areas}
          onChange={(value) =>
            setAreas(areaOptions.filter((option) => value.includes(option.id)).map((o) => o.id))
          }
        />
        <FilterButton
          label="Uses AI"
          single
          options={[
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ]}
          value={ai}
          onChange={setAi}
        />
      </div>
      <Strip
        cells={[
          { value: counts.all, label: 'analyzers' },
          { value: counts.overrides, label: 'overrides on repositories and groups' },
          { value: counts.ai, label: 'use AI' },
          {
            value: counts.warn,
            label: 'need a look',
            tone: counts.warn ? 'warning' : 'success',
          },
          ...(lastRun
            ? [{ value: formatRelative(lastRun), label: 'last run', end: true } satisfies StripCell]
            : []),
        ]}
      />
      {shown.length ? (
        <AnalyzerTable
          rows={shown}
          selected={current?.kind}
          onOpen={(kind) => open({ item: kind })}
        />
      ) : (
        <EmptyState title="No analyzer matches" description="Clear the filters to see every one." />
      )}
      <p className="text-xs text-muted">
        State comes from{' '}
        <Link to="/ops/automation" className="underline">
          Ops › Automation
        </Link>
        : freshness and the rules that queue an analyzer. Every change of options is written to the
        Audit log.
        {rows.some(needsLook) ? ' Analyzers with failed or budget-stopped runs need a look.' : ''}
      </p>
      {current ? (
        <AnalyzerSheet
          key={current.kind}
          row={current}
          rows={shown.some((row) => row.kind === current.kind) ? shown : rows}
          tab={parseTab(search.tab)}
          settings={settings.data}
          settingsError={settings.error}
          onSelect={(kind) => open({ item: kind })}
          onTab={(tab) => open({ tab: tab === 'runs' ? undefined : tab })}
          onClose={() => open({ item: undefined, tab: undefined })}
        />
      ) : null}
      {runAny.dialog}
    </div>
  )
}
