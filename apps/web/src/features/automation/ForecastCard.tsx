import { useAiOverview, useAiUsage } from '../../api/queries.ts'
import { automaticLimit, formatUsd } from '../../lib/ai-usage.ts'
import {
  forecastAutomaticSpend,
  forecastFrom,
  forecastSegments,
} from '../../lib/automation-forecast.ts'
import { Placeholder, SegmentBar, Tag } from '../../ui/index.ts'

const toneLabel = { default: 'no budget', success: 'fits', warning: 'close', danger: 'over' }

/**
 * Expected weekly AI spend of automatic work from the last weeks of AI usage, against the weekly
 * budget and the part of it automatic work may use (the budget minus its reserve).
 */
export function ForecastCard() {
  const now = new Date()
  const usage = useAiUsage({ groupBy: 'week,analyzer', from: forecastFrom(now) })
  const overview = useAiOverview()
  if (usage.isPending) return <Placeholder className="h-24" />
  if (usage.isError) return null
  const budget =
    overview.data?.budgets.find((b) => b.scope.all) ?? overview.data?.budgets[0] ?? undefined
  const forecast = forecastAutomaticSpend(usage.data.buckets, {
    now,
    ...(budget && { budget }),
  })
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3">
      <header className="flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">AI forecast</h3>
        <Tag tone={forecast.tone}>{toneLabel[forecast.tone]}</Tag>
        <span className="mono ml-auto text-[13px]">
          {formatUsd(forecast.forecastUsd)}
          <span className="text-muted"> / week</span>
        </span>
      </header>
      {budget ? (
        <>
          <SegmentBar segments={forecastSegments(forecast)} total={budget.weeklyUsd} />
          <p className="text-[11px] text-muted">
            Automatic work stops at{' '}
            <span className="mono">{formatUsd(automaticLimit(budget))}</span> of{' '}
            <span className="mono">{formatUsd(budget.weeklyUsd)}</span>; the last{' '}
            <span className="mono">{formatUsd(budget.reserveUsd)}</span> is kept for work people
            start. So far this week: <span className="mono">{formatUsd(forecast.thisWeekUsd)}</span>{' '}
            automatic.
          </p>
        </>
      ) : null}
      <p className="text-[11px] text-muted">
        {forecast.weeks
          ? `Average of the last ${forecast.weeks === 1 ? 'week' : `${forecast.weeks} weeks`}`
          : 'This week so far, projected'}
        {forecast.byAnalyzer.length
          ? `: ${forecast.byAnalyzer
              .slice(0, 4)
              .map((row) => `${row.analyzer} ${formatUsd(row.weeklyUsd)}`)
              .join(', ')}`
          : '; no automatic AI runs yet.'}
      </p>
    </section>
  )
}
