import { featureLabel, filterableFeatures } from '@holtkeeper/ai-usage/features'
import type { AiBudgetStatus, AiUsageOverview, AiUsagePeriodKind } from '@holtkeeper/api'
import { Cpu } from 'lucide-react'
import { useState } from 'react'

import { useAiOverview, useAiUsage } from '../../api/queries.ts'
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
import { viewGroups } from '../../lib/home-scope.ts'
import {
  EmptyState,
  ErrorState,
  NoTeamsState,
  FilterButton,
  Page,
  Placeholder,
  SegmentedTabs,
  Strip,
  type StripCell,
} from '../../ui/index.ts'
import { McpPeople } from '../mcp/McpPeople.tsx'
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

function stripCells(
  overview: AiUsageOverview,
  budget: AiBudgetStatus | undefined,
  narrowed: boolean,
): StripCell[] {
  const now = overview.current
  const before = overview.comparison
  const people = now.totals.costUsd - now.automaticUsd
  const delta = periodDelta(now.totals.costUsd, before.totals.costUsd)
  const label = periodLabel[overview.period]
  return [
    {
      prefix: label[0]?.toUpperCase() + label.slice(1),
      value: formatUsd(now.totals.costUsd),
      label:
        overview.period === 'week' && budget && !narrowed ? (
          <>of {formatUsd(budget.weeklyUsd)}</>
        ) : null,
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
  const narrowed = Boolean(filter.origin || filter.feature || filter.model)
  return (
    <>
      <Strip
        label="AI spend summary"
        cells={stripCells(overview, budget, narrowed)}
        className="-mx-4 -mt-4"
      />
      <div className="grid gap-5 xl:grid-cols-2">
        {budget ? (
          <BudgetCard
            budget={budget}
            narrower={overview.budgets.filter((entry) => entry !== budget)}
            caps={overview.caps}
            writable={canGlobal('settings:write')}
          />
        ) : (
          <EmptyState
            title="No budget you can see"
            description="Budgets show here for the scopes you may read AI spend of."
          />
        )}
        <DailyCost overview={overview} filter={filter} />
      </div>
      <Breakdowns from={overview.current.from} period={overview.period} filter={filter} />
      <SpendRuns
        key={`${overview.period}:${overview.current.from}`}
        from={overview.current.from}
        totals={overview.current.totals}
        filter={filter}
      />
      <div className="-mx-4 -mb-4">
        <McpPeople />
      </div>
    </>
  )
}

const starters = [
  { id: 'interactive', label: 'People' },
  { id: 'automatic', label: 'Automatic' },
] as const

const featureOptions = filterableFeatures.map((feature) => ({
  id: feature,
  label: featureLabel[feature],
}))

/**
 * Ops › AI spend: the period's figures, the weekly budget with its inline editor and caps, four
 * weeks of daily cost split into people and automatic work with forecast bars for the rest of the
 * week, spend by feature, repository and model, every model run and MCP usage by person. The scope
 * switch, Feature, Model and Started by narrow everything but the budget card, which always shows
 * the real budget (and MCP usage, which is no model spend).
 */
export function SpendPage() {
  const { canGlobal } = useSession()
  const { view, setView, homeGroups, ready, noTeams } = useScope()
  const [period, setPeriod] = useState<AiUsagePeriodKind>('week')
  const [origin, setOrigin] = useState<string[]>([])
  const [feature, setFeature] = useState<string[]>([])
  const [model, setModel] = useState<string[]>([])
  const groups = viewGroups(view, homeGroups)?.join(',') || undefined
  const started = starters.find((each) => each.id === origin[0])?.id
  const narrowTo = filterableFeatures.find((each) => each === feature[0])
  const filter: SpendRunsFilter = {
    ...(started && { origin: started }),
    ...(narrowTo && { feature: narrowTo }),
    ...(model[0] && { model: model[0] }),
    ...(groups && { groups }),
  }
  const scoped = ready && !noTeams && (view === 'all' || groups !== undefined)
  const overview = useAiOverview(scoped, { period, ...filter })
  const data = overview.data
  const models = useAiUsage(
    {
      groupBy: 'model',
      ...(data && { from: data.current.from }),
      ...(groups && { groups }),
    },
    scoped,
  )
  const modelOptions = (models.data?.buckets ?? [])
    .toSorted((a, b) => b.costUsd - a.costUsd)
    .flatMap((bucket) =>
      bucket.key.model ? [{ id: bucket.key.model, label: bucket.key.model }] : [],
    )
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
            label="Feature"
            options={featureOptions}
            value={feature}
            onChange={setFeature}
          />
          <FilterButton
            single
            label="Model"
            options={modelOptions}
            value={model}
            onChange={setModel}
          />
          <FilterButton
            single
            label="Started by"
            options={starters}
            value={origin}
            onChange={setOrigin}
          />
          {data ? (
            <span className="text-xs text-muted">{formatDateTime(data.current.from)} – now</span>
          ) : null}
        </>
      }
    >
      {noTeams ? (
        <NoTeamsState />
      ) : overview.isError ? (
        <ErrorState error={overview.error} />
      ) : data ? (
        <Body overview={data} filter={filter} />
      ) : (
        <Placeholder className="h-96" />
      )}
    </Page>
  )
}
