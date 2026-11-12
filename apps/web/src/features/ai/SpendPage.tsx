import type { AiBudgetStatus, AiUsageOverview, AiUsagePeriodKind } from '@holtkeeper/api'
import { Cpu } from 'lucide-react'
import { useState } from 'react'

import { useAiOverview } from '../../api/queries.ts'
import { featureLabel, featureOf } from '../../lib/ai-features.ts'
import {
  comparisonLabel,
  formatDelta,
  formatRatio,
  formatTokens,
  formatUsd,
  periodDelta,
  periodLabel,
  totalTokens,
} from '../../lib/ai-usage.ts'
import { formatDateTime } from '../../lib/format.ts'
import {
  EmptyState,
  ErrorState,
  FilterButton,
  Page,
  Placeholder,
  SegmentedTabs,
  Strip,
  type StripCell,
} from '../../ui/index.ts'
import { copyLinkItem } from '../shell/copy-link.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { Breakdowns } from './Breakdowns.tsx'
import { BudgetCard } from './BudgetCard.tsx'
import { DailyCost } from './DailyCost.tsx'
import { SpendRuns, type SpendRunsFilter } from './SpendRuns.tsx'

const periods: readonly { id: AiUsagePeriodKind; label: string }[] = [
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: '30d', label: 'Last 30 days' },
]

const isPeriod = (id: string): id is AiUsagePeriodKind => periods.some((p) => p.id === id)

const broadest = (budgets: readonly AiBudgetStatus[]) =>
  budgets.find((budget) => budget.id === 'default' || budget.scope.all === true) ?? budgets[0]

function stripCells(overview: AiUsageOverview, budget: AiBudgetStatus | undefined): StripCell[] {
  const now = overview.current
  const before = overview.comparison
  const people = now.totals.costUsd - now.automaticUsd
  const delta = periodDelta(now.totals.costUsd, before.totals.costUsd)
  const label = periodLabel[overview.period]
  return [
    {
      prefix: label[0]?.toUpperCase() + label.slice(1),
      value: formatUsd(now.totals.costUsd),
      label: overview.period === 'week' && budget ? <>of {formatUsd(budget.weeklyUsd)}</> : null,
    },
    { prefix: 'Forecast', value: formatUsd(overview.forecast.forecastUsd), label: 'by week end' },
    {
      prefix: 'Automatic',
      value: formatUsd(now.automaticUsd),
      label: (
        <>
          · people <b className="tabular font-semibold text-foreground">{formatUsd(people)}</b>
        </>
      ),
    },
    { prefix: 'Runs', value: now.totals.runs.toLocaleString('en'), label: null },
    { prefix: 'Tokens', value: formatTokens(totalTokens(now.totals)), label: null },
    { prefix: 'Cache hit', value: formatRatio(overview.cacheHitRatio), label: null },
    {
      prefix: 'Cost',
      value: formatDelta(delta, comparisonLabel[overview.period]),
      label: null,
    },
    {
      tone: now.totals.errors ? 'danger' : 'none',
      value: now.totals.errors.toLocaleString('en'),
      label: `errors · ${formatRatio(overview.errorRate)}`,
      end: true,
    },
    {
      tone: now.totals.denied ? 'code' : 'none',
      value: now.totals.denied.toLocaleString('en'),
      label: 'blocked by budget',
    },
    {
      tone: now.totals.unknownCost ? 'warning' : 'none',
      value: now.totals.unknownCost.toLocaleString('en'),
      label: 'unknown cost',
    },
  ]
}

function Body({ overview, filter }: { overview: AiUsageOverview; filter: SpendRunsFilter }) {
  const { canGlobal } = useSession()
  const budget = broadest(overview.budgets)
  return (
    <>
      <Strip
        label="AI spend summary"
        cells={stripCells(overview, budget)}
        className="-mx-4 -mt-4"
      />
      <div className="grid gap-5 xl:grid-cols-2">
        {budget ? (
          <BudgetCard
            budget={budget}
            narrower={overview.budgets.filter((entry) => entry !== budget)}
            writable={canGlobal('settings:write')}
          />
        ) : (
          <EmptyState
            title="No budget you can see"
            description="Budgets show here for the scopes you may read AI spend of."
          />
        )}
        <DailyCost overview={overview} />
      </div>
      <Breakdowns
        from={overview.current.from}
        period={overview.period}
        {...(filter.groups && { groups: filter.groups })}
      />
      <SpendRuns
        key={`${overview.period}:${overview.current.from}`}
        from={overview.current.from}
        totals={overview.current.totals}
        filter={filter}
      />
    </>
  )
}

const starters = [
  { id: 'interactive', label: 'People' },
  { id: 'automatic', label: 'Automatic' },
] as const

const taskOptions = (overview: AiUsageOverview | undefined) =>
  (overview?.topTaskKinds ?? []).flatMap((bucket) =>
    bucket.key.taskKind
      ? [
          {
            id: bucket.key.taskKind,
            label: `${featureLabel[featureOf(bucket.key.taskKind)]} · ${bucket.key.taskKind}`,
          },
        ]
      : [],
  )

const modelOptions = (overview: AiUsageOverview | undefined) =>
  (overview?.topModels ?? []).flatMap((bucket) =>
    bucket.key.model ? [{ id: bucket.key.model, label: bucket.key.model }] : [],
  )

/**
 * Ops › AI spend: the period's figures, the weekly budget with its inline editor, four weeks of
 * daily cost split into people and automatic work, spend by feature, repository and model, and
 * every model run. The scope switch narrows everything to the groups of My teams; Started by, Task
 * and Model narrow the runs.
 */
export function SpendPage() {
  const { canGlobal } = useSession()
  const { view, setView, homeGroups } = useScope()
  const [period, setPeriod] = useState<AiUsagePeriodKind>('week')
  const [origin, setOrigin] = useState<string[]>([])
  const [taskKind, setTaskKind] = useState<string[]>([])
  const [model, setModel] = useState<string[]>([])
  const groups =
    view === 'mine' && homeGroups.length ? [...new Set(homeGroups.flat())].join(',') : undefined
  const overview = useAiOverview(true, { period, ...(groups && { groups }) })
  const data = overview.data
  const started = starters.find((each) => each.id === origin[0])?.id
  const filter: SpendRunsFilter = {
    ...(started && { origin: started }),
    ...(taskKind[0] && { taskKind: taskKind[0] }),
    ...(model[0] && { model: model[0] }),
    ...(groups && { groups }),
  }
  return (
    <Page
      crumbs={[{ label: 'AI spend' }]}
      scope={{ value: view, onChange: setView }}
      {...(canGlobal('settings:read') && {
        configure: { link: { to: '/settings/$section', params: { section: 'ai' } } },
      })}
      more={[
        copyLinkItem,
        ...(canGlobal('settings:read')
          ? [{ label: 'Providers and models', icon: Cpu, href: '/settings/ai#providers' }]
          : []),
      ]}
      filters={
        <>
          <SegmentedTabs
            aria-label="Period"
            items={periods}
            selected={period}
            onSelect={(id) => {
              if (isPeriod(id)) setPeriod(id)
            }}
          />
          <FilterButton
            single
            label="Started by"
            options={starters}
            value={origin}
            onChange={setOrigin}
          />
          <FilterButton
            single
            label="Task"
            options={taskOptions(data)}
            value={taskKind}
            onChange={setTaskKind}
          />
          <FilterButton
            single
            label="Model"
            options={modelOptions(data)}
            value={model}
            onChange={setModel}
          />
          {data ? (
            <span className="text-xs text-muted">{formatDateTime(data.current.from)} – now</span>
          ) : null}
        </>
      }
    >
      {overview.isError ? (
        <ErrorState error={overview.error} />
      ) : data ? (
        <Body overview={data} filter={filter} />
      ) : (
        <Placeholder className="h-96" />
      )}
    </Page>
  )
}
