import type { AiBudgetStatus, AiUsageOverview } from '@holtkeeper/api'
import { CircleDollarSign, Coins, DatabaseZap, Sparkles, TriangleAlert, Wallet } from 'lucide-react'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'

import { useAiOverview, useAiUsage } from '../../api/queries.ts'
import {
  type CostItem,
  automaticLimit,
  budgetBar,
  budgetTone,
  costItems,
  fillDays,
  formatDelta,
  formatRatio,
  formatTokens,
  formatUsd,
  periodDelta,
  totalTokens,
  windowStart,
} from '../../lib/ai-usage.ts'
import { plural } from '../../lib/format.ts'
import {
  AnimatedNumber,
  Chip,
  EmptyState,
  ErrorState,
  Panel,
  Placeholder,
  fadeItem,
  stagger,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { SettingsSection } from '../settings/SettingsSection.tsx'
import { CostChart } from './CostChart.tsx'
import { RunsTable } from './RunsTable.tsx'

const chartDays = 30

const toneText = { success: 'text-success', danger: 'text-danger', default: 'text-muted' } as const
const toneBar = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
} as const

const monthLabel = (from: string) =>
  new Date(from).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })

function Metric({
  label,
  value,
  format,
  icon,
  hint,
}: {
  label: string
  value: number
  format: (value: number) => string
  icon: ReactNode
  hint?: ReactNode
}) {
  return (
    <motion.div {...fadeItem} className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2 text-sm text-muted">
        <span>{label}</span>
        <span className="[&_svg]:size-4">{icon}</span>
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">
        <AnimatedNumber value={value} format={format} />
      </div>
      {hint ? <div className="mt-1 text-xs">{hint}</div> : null}
    </motion.div>
  )
}

function Delta({
  current,
  previous,
  better = 'down',
}: {
  current: number
  previous: number
  better?: 'up' | 'down'
}) {
  const delta = periodDelta(current, previous, better)
  return <span className={toneText[delta.tone]}>{formatDelta(delta)}</span>
}

function Metrics({ overview }: { overview: AiUsageOverview }) {
  const now = overview.month.totals
  const before = overview.previousMonth.totals
  return (
    <motion.div {...stagger} className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Metric
        label="Cost"
        value={now.costUsd}
        format={formatUsd}
        icon={<CircleDollarSign />}
        hint={<Delta current={now.costUsd} previous={before.costUsd} />}
      />
      <Metric
        label="Tokens"
        value={totalTokens(now)}
        format={formatTokens}
        icon={<Coins />}
        hint={<Delta current={totalTokens(now)} previous={totalTokens(before)} />}
      />
      <Metric
        label="Runs"
        value={now.runs}
        format={(value) => String(Math.round(value))}
        icon={<Sparkles />}
        hint={
          <span className="text-muted">
            {now.denied ? `${now.denied} over budget · ` : ''}
            {formatDelta(periodDelta(now.runs, before.runs))}
          </span>
        }
      />
      <Metric
        label="Errors"
        value={now.errors}
        format={(value) => String(Math.round(value))}
        icon={<TriangleAlert />}
        hint={<span className="text-muted">{formatRatio(overview.errorRate)} of runs</span>}
      />
      <Metric
        label="Cache hit ratio"
        value={overview.cacheHitRatio}
        format={formatRatio}
        icon={<DatabaseZap />}
        hint={<span className="text-muted">Cache reads over all input tokens</span>}
      />
    </motion.div>
  )
}

function TopList({ items, empty }: { items: CostItem[]; empty: string }) {
  if (!items.length) return <EmptyState icon={<Sparkles />} title={empty} />
  const max = Math.max(0.0001, ...items.map((item) => item.costUsd))
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item, index) => (
        <li key={item.name} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{item.name}</span>
            <span className="tabular shrink-0 text-muted">
              {formatUsd(item.costUsd)} · {plural(item.runs, 'run')}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-default">
            <motion.div
              className="h-full rounded-full"
              style={{ background: 'var(--series-1)' }}
              initial={{ width: 0 }}
              animate={{ width: `${(item.costUsd / max) * 100}%` }}
              transition={{ type: 'spring', stiffness: 140, damping: 24, delay: index * 0.03 }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Budget({ budget }: { budget: AiBudgetStatus }) {
  const tone = budgetTone(budget)
  const bar = budgetBar(budget)
  const automatic = automaticLimit(budget)
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {budget.id === 'default' ? (
          <span className="text-sm text-muted">Default budget</span>
        ) : (
          <ScopeBadge scope={budget.scope} />
        )}
        <Chip tone={budget.action === 'block' ? 'danger' : 'warning'}>
          {budget.action === 'block' ? 'Blocks runs' : 'Warns'}
        </Chip>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span>This week</span>
          <span className="tabular text-muted">
            {formatUsd(budget.spentUsd)} of {formatUsd(budget.weeklyUsd)} ·{' '}
            {Math.round(budget.percent)}%
          </span>
        </div>
        <div
          className="relative h-2 rounded-full bg-default"
          role="meter"
          aria-label="Weekly budget used"
          aria-valuemin={0}
          aria-valuemax={budget.weeklyUsd}
          aria-valuenow={Math.min(budget.spentUsd, budget.weeklyUsd)}
        >
          <div className="absolute inset-0 overflow-hidden rounded-full">
            <div
              className="absolute inset-y-0 left-0 rounded-full opacity-30"
              style={{ width: `${bar.projected}%`, background: toneBar[tone] }}
            />
            <motion.div
              className="relative h-full rounded-full"
              style={{ background: toneBar[tone] }}
              initial={{ width: 0 }}
              animate={{ width: `${bar.spent}%` }}
              transition={{ type: 'spring', stiffness: 140, damping: 24 }}
            />
          </div>
          {budget.reserveUsd > 0 ? (
            <div
              className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full opacity-60"
              style={{ left: `${bar.reserve}%`, background: 'var(--foreground)' }}
              title={`Automatic work stops at ${formatUsd(automatic)}`}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted">
          <span>
            {budget.reserveUsd > 0
              ? `Automatic work stops at ${formatUsd(automatic)}; the last ${formatUsd(budget.reserveUsd)} is kept for people`
              : 'No reserve for people'}
          </span>
          <span className={budget.projectedUsd > budget.weeklyUsd ? 'text-warning' : undefined}>
            Projected {formatUsd(budget.projectedUsd)} by week end
          </span>
        </div>
      </div>
    </li>
  )
}

/** AI spend and usage: this month against the last, budgets, daily cost, top spenders and runs. */
export function AiUsage() {
  const overview = useAiOverview()
  const daily = useAiUsage({ groupBy: 'day', from: windowStart(chartDays) })

  if (overview.isError)
    return (
      <SettingsSection title="AI usage">
        <ErrorState error={overview.error} />
      </SettingsSection>
    )

  const data = overview.data
  return (
    <SettingsSection
      title="AI usage"
      description={
        data
          ? `${monthLabel(data.month.from)} compared with ${monthLabel(data.previousMonth.from)}`
          : 'Model spend, tokens and runs'
      }
    >
      {data ? (
        <Metrics overview={data} />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Placeholder key={i} className="h-28" />
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Daily cost"
          description={`Last ${chartDays} days, UTC`}
        >
          {daily.isPending ? (
            <Placeholder className="h-64" />
          ) : daily.isError ? (
            <ErrorState error={daily.error} />
          ) : (
            <CostChart points={fillDays(daily.data.buckets, chartDays)} />
          )}
        </Panel>
        <Panel
          title="Budgets"
          description="This week’s spend, from Monday 00:00 in the instance time zone"
        >
          {!data ? (
            <Placeholder className="h-40" />
          ) : data.budgets.length ? (
            <ul className="flex flex-col gap-3">
              {data.budgets.map((budget) => (
                <Budget key={budget.id} budget={budget} />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Wallet />}
              title="No budgets"
              description="Add an `llm.budget` setting to cap or watch spend."
            />
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {(
          [
            ['Top repositories', 'repo', data?.topRepos],
            ['Top models', 'model', data?.topModels],
            ['Top task kinds', 'taskKind', data?.topTaskKinds],
          ] as const
        ).map(([title, dimension, buckets]) => (
          <Panel key={dimension} title={title} description="This month, by cost">
            {buckets ? (
              <TopList items={costItems(buckets, dimension)} empty="No runs this month" />
            ) : (
              <Placeholder className="h-40" />
            )}
          </Panel>
        ))}
      </div>

      <Panel title="Runs" description="Every model run, newest first">
        <RunsTable />
      </Panel>
    </SettingsSection>
  )
}
