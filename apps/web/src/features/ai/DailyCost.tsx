import type { AiUsageOverview } from '@holtkeeper/api'

import { useAiUsage } from '../../api/queries.ts'
import {
  chartDays,
  chartStart,
  formatUsd,
  niceScale,
  originDays,
  periodLabel,
  type OriginDay,
} from '../../lib/ai-usage.ts'
import { formatDayLabel, plural } from '../../lib/format.ts'
import { ErrorState, Legend, Panel, Placeholder, Tag } from '../../ui/index.ts'

const peopleColor = 'color-mix(in oklab, var(--fg) 78%, transparent)'
const automaticColor = 'color-mix(in oklab, var(--fg) 32%, transparent)'

const dayTitle = (day: OriginDay) =>
  `${formatDayLabel(day.day)}: people ${formatUsd(day.people)}, automatic ${formatUsd(day.automatic)}`

function Bars({ days }: { days: OriginDay[] }) {
  const scale = niceScale(Math.max(...days.map((day) => day.people + day.automatic)))
  const lines = Array.from(
    { length: Math.round(scale.max / scale.step) + 1 },
    (_, i) => i * scale.step,
  )
  const pct = (value: number) => `${(value / scale.max) * 100}%`
  const weeks = [0, 1, 2, 3].map((week) => days.slice(week * 7, week * 7 + 7))
  const total = days.reduce((sum, day) => sum + day.people + day.automatic, 0)
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="relative ml-9 h-[150px]"
        role="img"
        aria-label={`Daily AI cost for ${chartDays} days, ${formatUsd(total)} in total. ${weeks
          .map(
            (week) =>
              `Week of ${formatDayLabel(week[0]?.day ?? '')}: ${formatUsd(week.reduce((sum, day) => sum + day.people + day.automatic, 0))}`,
          )
          .join('. ')}.`}
      >
        {lines.map((value) => (
          <span
            key={value}
            className="absolute inset-x-0 border-t border-line"
            style={{ bottom: pct(value) }}
          >
            <span className="absolute -left-9 -top-[7px] font-mono text-[10px] text-dim">
              ${value}
            </span>
          </span>
        ))}
        <div className="absolute inset-0 flex items-end gap-[3px]">
          {days.map((day, index) => (
            <div
              key={day.day}
              title={day.future ? `${formatDayLabel(day.day)}: not yet` : dayTitle(day)}
              className={`flex h-full min-w-0 flex-1 flex-col justify-end ${index % 7 === 0 && index ? 'ml-1.5' : ''}`}
            >
              {day.future ? (
                <i className="block h-px w-full bg-line" />
              ) : (
                <>
                  <i
                    className="block w-full rounded-t-[2px]"
                    style={{
                      height: pct(day.people),
                      background: peopleColor,
                      ...(day.today ? { boxShadow: '0 -2px 0 var(--brand)' } : {}),
                    }}
                  />
                  <i
                    className="block w-full"
                    style={{ height: pct(day.automatic), background: automaticColor }}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="ml-9 grid grid-cols-4 gap-1.5 text-[11px] text-dim">
        {weeks.map((week, index) => (
          <span key={week[0]?.day ?? index} className="truncate">
            {formatDayLabel(week[0]?.day ?? '')}
            {index === 3 ? (
              ' · this week'
            ) : (
              <>
                {' · '}
                <span className="font-mono">
                  {formatUsd(week.reduce((sum, day) => sum + day.people + day.automatic, 0))}
                </span>
              </>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Daily cost of four Monday-to-Sunday weeks (UTC) split into work people started and automatic
 * work, with this budget week's forecast and the analyzers automatic work spent on.
 */
export function DailyCost({ overview }: { overview: AiUsageOverview }) {
  const start = chartStart()
  const usage = useAiUsage({ groupBy: 'day,origin', from: start })
  const days = usage.data ? originDays(usage.data.buckets, start) : undefined
  const lastWeek = days?.slice(14, 21).reduce((sum, day) => sum + day.people + day.automatic, 0)
  const analyzers = overview.topAnalyzers.filter((bucket) => bucket.key.analyzer)
  const forecast = overview.forecast
  return (
    <Panel
      variant="flush"
      title="Daily cost"
      description="4 weeks, Monday to Sunday, UTC"
      actions={
        <Legend
          label="Chart legend"
          items={[
            { color: peopleColor, label: 'People' },
            { color: automaticColor, label: 'Automatic' },
          ]}
        />
      }
      contentClassName="flex flex-col gap-3"
    >
      {usage.isError ? (
        <ErrorState error={usage.error} />
      ) : days ? (
        <Bars days={days} />
      ) : (
        <Placeholder className="h-[170px]" />
      )}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 border-t border-line pt-2.5">
        <div className="flex flex-col">
          <small className="text-[11px] text-dim">Forecast to week end</small>
          <span className="font-mono text-lg font-semibold">{formatUsd(forecast.forecastUsd)}</span>
        </div>
        <div className="flex flex-col">
          <small className="text-[11px] text-dim">
            {forecast.weeks
              ? `Automatic work, average of ${plural(forecast.weeks, 'full week')}`
              : 'Automatic work, this week’s pace'}
          </small>
          <span className="font-mono">
            {formatUsd(forecast.automaticWeeklyMeanUsd)} <span className="text-dim">/ week</span>
          </span>
        </div>
        {lastWeek !== undefined ? (
          <div className="flex flex-col">
            <small className="text-[11px] text-dim">Last week, UTC</small>
            <span className="font-mono">{formatUsd(lastWeek)}</span>
          </div>
        ) : null}
      </div>
      <span className="text-xs text-muted">
        Forecast = this week so far plus the average rest of the week over the last 4 full weeks.
      </span>
      {analyzers.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-dim">
            By analyzer, {periodLabel[overview.period]}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {analyzers.map((bucket) => (
              <Tag key={bucket.key.analyzer} mono>
                {bucket.key.analyzer} {formatUsd(bucket.costUsd)}
              </Tag>
            ))}
          </div>
        </div>
      ) : null}
    </Panel>
  )
}
