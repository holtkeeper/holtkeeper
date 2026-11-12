import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { useState } from 'react'

import { useMcpUsage } from '../../api/queries.ts'
import { formatCount, formatDayLabel, formatRelative } from '../../lib/format.ts'
import { type RankedRow, rankedRows, usageBars } from '../../lib/mcp-usage.ts'
import { ErrorState, Legend, Placeholder, SegmentedTabs } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

const ranges = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
] as const

type Range = (typeof ranges)[number]['id']

const answeredColor = 'color-mix(in oklab, var(--fg) 82%, transparent)'
const failedColor = 'var(--danger)'

function RankedList({ label, rows }: { label: string; rows: readonly RankedRow[] }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <li
          key={row.name}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-[12px]"
        >
          <span className="mono truncate">{row.name}</span>
          <span className="mono text-muted">{formatCount(row.calls)}</span>
          <span className="col-span-2 h-1 overflow-hidden rounded bg-sunk">
            <b
              className="block h-full rounded"
              style={{ width: `${row.share * 100}%`, background: answeredColor }}
            />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Account › Connect agents › My usage: the viewer's own MCP calls over 7, 30 or 90 days as a
 * daily chart of answered and failed calls, totals, the last call and the most used tools,
 * packages and clients.
 */
export function MyUsage() {
  const [range, setRange] = useState<Range>('7')
  const usage = useMcpUsage(Number(range))
  const { can } = useSession()
  const me = usage.data?.me
  const bars =
    usage.data && me
      ? usageBars(
          usage.data.days.map((day, index) => ({
            date: day.date,
            calls: me.daily[index] ?? 0,
            errors: me.dailyErrors[index] ?? 0,
          })),
        )
      : []
  const step = Math.ceil(bars.length / 7)
  return (
    <section aria-labelledby="my-usage" className="flex flex-col rounded-[10px] border border-line">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <h3 id="my-usage" className="text-[13px] font-semibold">
          My usage
        </h3>
        <span className="text-xs text-muted">Tool calls your tokens made</span>
        <SegmentedTabs
          aria-label="Range"
          className="ms-auto"
          items={ranges}
          selected={range}
          onSelect={(id) => setRange(ranges.find((each) => each.id === id)?.id ?? range)}
        />
      </header>
      {usage.isPending ? (
        <Placeholder className="m-3.5 h-40" />
      ) : usage.isError ? (
        <div className="p-3.5">
          <ErrorState error={usage.error} />
        </div>
      ) : me ? (
        <>
          <div className="flex flex-col gap-2.5 px-3.5 py-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
              <span>
                Tool calls <b className="mono text-foreground">{formatCount(me.calls)}</b>
              </span>
              <span>
                Failed <b className="mono text-foreground">{formatCount(me.errors)}</b>
              </span>
              <span>
                Last call{' '}
                <b className="text-foreground">{me.lastAt ? formatRelative(me.lastAt) : 'never'}</b>
              </span>
            </div>
            <div
              role="img"
              aria-label={`Tool calls per day over ${range} days: ${formatCount(me.calls)} in total, ${formatCount(me.errors)} failed.`}
              className="flex h-24 items-end gap-[3px]"
            >
              {bars.map((bar) => (
                <div
                  key={bar.date}
                  title={`${formatDayLabel(bar.date)}: ${formatCount(bar.answered)} answered, ${formatCount(bar.failed)} failed`}
                  className="flex h-full min-w-0 flex-1 flex-col justify-end"
                >
                  {bar.answered || bar.failed ? (
                    <>
                      <i
                        className="block w-full rounded-t-[2px]"
                        style={{ height: `${bar.failedPct}%`, background: failedColor }}
                      />
                      <i
                        className="block w-full"
                        style={{ height: `${bar.answeredPct}%`, background: answeredColor }}
                      />
                    </>
                  ) : (
                    <i className="block h-px w-full bg-line" />
                  )}
                </div>
              ))}
            </div>
            <div className="mono flex justify-between text-[10px] text-dim">
              {bars
                .filter((_, index) => index % step === 0)
                .map((bar) => (
                  <span key={bar.date}>{formatDayLabel(bar.date)}</span>
                ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Legend
                items={[
                  { label: 'Answered', color: answeredColor },
                  { label: 'Failed', color: failedColor },
                ]}
              />
              {can('ai:read') || can('ai:admin') ? (
                <Link
                  to="/ops/spend"
                  className="ms-auto inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
                >
                  Usage by person in Ops › AI spend
                  <ArrowRight className="size-3" />
                </Link>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3.5 border-t border-line px-3.5 py-3 sm:grid-cols-3">
            {(
              [
                [
                  'Tools',
                  'Tools you called most',
                  me.tools.map((r) => ({ name: r.tool, calls: r.calls })),
                ],
                ['Packages', 'Packages your calls asked about most', me.packages],
                [
                  'Clients',
                  'Clients you called from most',
                  me.clients.map((r) => ({ name: r.client, calls: r.calls })),
                ],
              ] as const
            ).map(([title, label, rows]) => (
              <div key={title} className="flex min-w-0 flex-col gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-dim">
                  {title}
                </span>
                {rows.length ? (
                  <RankedList label={label} rows={rankedRows(rows)} />
                ) : (
                  <p className="text-xs text-muted">None in this range.</p>
                )}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  )
}
