import type { AiUsagePeriodKind, ReviewAnalytics, ReviewCostDay } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { useReviewAnalytics } from '../../api/queries.ts'
import { canReadSpend } from '../../lib/access.ts'
import { formatUsd, niceScale } from '../../lib/ai-usage.ts'
import { formatDateTime, formatDayLabel, plural } from '../../lib/format.ts'
import { viewTeams } from '../../lib/home-scope.ts'
import { parseRepoKey, repoSplat } from '../../lib/repo.ts'
import {
  analyticsPhases,
  dayTotal,
  phaseInfo,
  replyCount,
  reviewSpend,
  share,
} from '../../lib/review-analytics.ts'
import { acceptanceTone, outcomeSegments, shareText } from '../../lib/reviews.ts'
import { statusColor } from '../../ui/colors.ts'
import {
  ErrorState,
  Legend,
  NoTeamsState,
  Page,
  Panel,
  Placeholder,
  SegmentBar,
  SegmentedTabs,
  Strip,
  type StripCell,
  Tag,
} from '../../ui/index.ts'
import { copyLinkItem } from '../shell/copy-link.ts'
import { Forbidden } from '../shell/Forbidden.tsx'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'

const periods: readonly { id: AiUsagePeriodKind; label: string }[] = [
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: '30d', label: 'Last 30 days' },
]

const isPeriod = (id: string): id is AiUsagePeriodKind => periods.some((p) => p.id === id)

const phaseColor = (phase: keyof typeof phaseInfo) => statusColor[phaseInfo[phase].tone]

const phaseLegend = analyticsPhases.map((phase) => ({
  color: phaseColor(phase),
  label: phaseInfo[phase].label,
}))

const phaseSegments = (phases: Partial<Record<keyof typeof phaseInfo, number>>) =>
  analyticsPhases.map((phase) => ({
    value: Math.round((phases[phase] ?? 0) * 100),
    tone: phaseInfo[phase].tone,
    label: `cents on ${phaseInfo[phase].label.toLowerCase()}`,
  }))

const Figure = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div className="flex min-w-0 flex-col" title={hint}>
    <small className="text-[11px] text-dim">{label}</small>
    <span className="font-mono text-lg font-semibold">{value}</span>
  </div>
)

function stripCells(data: ReviewAnalytics): StripCell[] {
  const spend = reviewSpend(data)
  const { mergeRequests, outcomes } = data
  const replies = replyCount(data.runs.replies)
  return [
    { prefix: 'Review spend', value: formatUsd(spend), label: null },
    {
      prefix: 'Per merge request',
      value: mergeRequests.meanUsd === undefined ? '—' : formatUsd(mergeRequests.meanUsd),
      label: 'mean',
      ...(mergeRequests.medianUsd !== undefined && {
        caption: `· median ${formatUsd(mergeRequests.medianUsd)}`,
      }),
    },
    {
      value: mergeRequests.count.toLocaleString('en'),
      label: mergeRequests.count === 1 ? 'merge request' : 'merge requests',
    },
    { value: data.findings.posted.toLocaleString('en'), label: 'comments posted' },
    { value: replies.toLocaleString('en'), label: replies === 1 ? 'reply' : 'replies' },
    {
      tone: outcomes.acceptance === undefined ? 'none' : acceptanceTone(outcomes.acceptance),
      value: shareText(outcomes.acceptance),
      label: 'accepted',
      end: true,
    },
    {
      prefix: 'Per fixed comment',
      value: data.costPerFixedUsd === undefined ? '—' : formatUsd(data.costPerFixedUsd),
      label: null,
    },
  ]
}

function dayTitle(day: ReviewCostDay): string {
  const parts = analyticsPhases.flatMap((phase) => {
    const cost = day.phases[phase] ?? 0
    return cost > 0 ? [`${phaseInfo[phase].label.toLowerCase()} ${formatUsd(cost)}`] : []
  })
  return `${formatDayLabel(day.day)}: ${parts.length ? parts.join(', ') : 'nothing'}`
}

function PhaseBars({ days }: { days: ReviewCostDay[] }) {
  const scale = niceScale(Math.max(...days.map(dayTotal)))
  const lines = Array.from(
    { length: Math.round(scale.max / scale.step) + 1 },
    (_, i) => i * scale.step,
  )
  const pct = (value: number) => `${(value / scale.max) * 100}%`
  const total = days.reduce((sum, day) => sum + dayTotal(day), 0)
  const first = days[0]?.day ?? ''
  const last = days.at(-1)?.day ?? ''
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="relative ml-9 h-[150px]"
        role="img"
        aria-label={`Daily review cost from ${formatDayLabel(first)} to ${formatDayLabel(last)}, ${formatUsd(total)} in total.`}
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
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {days.map((day) => (
            <div
              key={day.day}
              title={dayTitle(day)}
              className="flex h-full min-w-0 flex-1 flex-col-reverse"
            >
              {dayTotal(day) > 0 ? (
                analyticsPhases.map((phase) => {
                  const cost = day.phases[phase] ?? 0
                  return cost > 0 ? (
                    <i
                      key={phase}
                      className="block w-full first:rounded-none last:rounded-t-[2px]"
                      style={{ height: pct(cost), background: phaseColor(phase) }}
                    />
                  ) : null
                })
              ) : (
                <i className="block h-px w-full bg-line" />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="ml-9 flex justify-between text-[11px] text-dim">
        <span>{formatDayLabel(first)}</span>
        <span>{formatDayLabel(last)}</span>
      </div>
    </div>
  )
}

function CostByPhase({ data }: { data: ReviewAnalytics }) {
  const spend = reviewSpend(data)
  return (
    <Panel
      variant="flush"
      title="Cost by phase"
      description="Daily review spend, UTC"
      actions={<Legend label="Phases" items={phaseLegend} />}
      contentClassName="flex flex-col gap-3"
    >
      <PhaseBars days={data.days} />
      <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
        {data.phases.map((entry) => (
          <div
            key={entry.phase}
            title={phaseInfo[entry.phase].description}
            className="grid grid-cols-[minmax(7rem,1fr)_minmax(6rem,2fr)_4rem_4.5rem] items-center gap-x-3 text-xs"
          >
            <span className="flex items-center gap-1.5">
              <i
                aria-hidden
                className="inline-block size-2 rounded-sm"
                style={{ background: phaseColor(entry.phase) }}
              />
              {phaseInfo[entry.phase].label}
            </span>
            <SegmentBar
              segments={[
                {
                  value: Math.round(entry.costUsd * 100),
                  tone: phaseInfo[entry.phase].tone,
                  label: 'cents',
                },
              ]}
              total={Math.max(1, Math.round(spend * 100))}
            />
            <span className="mono text-right text-muted">{plural(entry.runs, 'run')}</span>
            <span className="mono text-right">{formatUsd(entry.costUsd)}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function MergeRequestName({ entry }: { entry: ReviewAnalytics['mergeRequests']['top'][number] }) {
  const repo = parseRepoKey(entry.repo)
  const title = entry.title ?? `!${entry.mergeRequest}`
  return (
    <span className="flex min-w-0 flex-col">
      {entry.url ? (
        <a href={entry.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
          {title}
        </a>
      ) : (
        <span className="truncate">{title}</span>
      )}
      <span className="truncate font-mono text-[11px] text-dim">
        {repo ? (
          <Link to="/repos/$" params={{ _splat: repoSplat(repo) }} className="hover:underline">
            {repo.path}
          </Link>
        ) : (
          entry.repo
        )}{' '}
        !{entry.mergeRequest}
      </span>
    </span>
  )
}

function CostPerMergeRequest({ data }: { data: ReviewAnalytics }) {
  const { mergeRequests } = data
  return (
    <Panel
      variant="flush"
      title="Cost per merge request"
      description="Every review run of a merge request in the period, by phase"
      contentClassName="flex flex-col gap-3"
    >
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        <Figure
          label="Mean"
          value={mergeRequests.meanUsd === undefined ? '—' : formatUsd(mergeRequests.meanUsd)}
        />
        <Figure
          label="Median"
          value={mergeRequests.medianUsd === undefined ? '—' : formatUsd(mergeRequests.medianUsd)}
        />
        <Figure
          label="90th percentile"
          value={mergeRequests.p90Usd === undefined ? '—' : formatUsd(mergeRequests.p90Usd)}
          hint="Nine in ten merge requests cost this much or less"
        />
        <Figure label="Merge requests" value={mergeRequests.count.toLocaleString('en')} />
      </div>
      {mergeRequests.top.length ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[minmax(9rem,2fr)_minmax(5rem,1fr)_4.5rem] gap-x-3 text-[11px] font-medium uppercase tracking-wide text-dim">
            <span>Most expensive</span>
            <span>Phases</span>
            <span className="text-right">Cost</span>
          </div>
          {mergeRequests.top.map((entry) => (
            <div
              key={`${entry.repo}!${entry.mergeRequest}`}
              className="grid grid-cols-[minmax(9rem,2fr)_minmax(5rem,1fr)_4.5rem] items-center gap-x-3 text-xs"
            >
              <MergeRequestName entry={entry} />
              <SegmentBar segments={phaseSegments(entry.phases)} />
              <span className="mono text-right">{formatUsd(entry.costUsd)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">No review runs recorded their merge request yet.</p>
      )}
      {mergeRequests.untrackedUsd > 0 ? (
        <span className="text-xs text-muted">
          {formatUsd(mergeRequests.untrackedUsd)} of review spend has no merge request recorded:
          runs from before merge requests were kept on usage records.
        </span>
      ) : null}
    </Panel>
  )
}

function Activity({ data }: { data: ReviewAnalytics }) {
  const { runs } = data
  const replies = replyCount(runs.replies)
  return (
    <Panel
      variant="flush"
      title="Reviews and replies"
      description="Review records of the period"
      contentClassName="flex flex-col gap-3"
    >
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        <Figure
          label="Full reviews"
          value={runs.full.toLocaleString('en')}
          hint="First reviews, and reviews of everything again after a force push"
        />
        <Figure
          label="New commits"
          value={runs.incremental.toLocaleString('en')}
          hint="Reviews of the commits pushed since the last review"
        />
        <Figure
          label="Skipped"
          value={runs.skipped.toLocaleString('en')}
          hint="Diff too large or nothing in scope"
        />
        <Figure label="Replies" value={replies.toLocaleString('en')} />
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-dim">
          When a person replied in a thread
        </span>
        {replies ? (
          <>
            <SegmentBar
              segments={[
                { value: runs.replies.explain, tone: 'info', label: 'stood by the comment' },
                { value: runs.replies.concede, tone: 'warning', label: 'agreed with the person' },
                { value: runs.replies.update, tone: 'success', label: 'proposed other code' },
                { value: runs.replies.fixed, tone: 'success', label: 'confirmed a fix' },
                { value: runs.replies.open, tone: 'info', label: 'still applies' },
                { value: runs.replies.unknown, tone: 'default', label: 'not recorded' },
              ]}
            />
            <Legend
              label="Replies"
              items={[
                { tone: 'info', label: `stood by the comment ${runs.replies.explain}` },
                { tone: 'warning', label: `agreed with the person ${runs.replies.concede}` },
                { tone: 'success', label: `proposed other code ${runs.replies.update}` },
                { tone: 'success', label: `confirmed a fix ${runs.replies.fixed}` },
                { tone: 'info', label: `still applies ${runs.replies.open}` },
                ...(runs.replies.unknown
                  ? [{ tone: 'default' as const, label: `not recorded ${runs.replies.unknown}` }]
                  : []),
              ]}
            />
          </>
        ) : (
          <p className="text-xs text-muted">Nobody replied to a review comment in this period.</p>
        )}
      </div>
    </Panel>
  )
}

function Comments({ data }: { data: ReviewAnalytics }) {
  const { findings, outcomes } = data
  const raised = findings.posted + findings.refuted
  return (
    <Panel
      variant="flush"
      title="What happened to the comments"
      description="Outcomes of merge requests merged in the period"
      contentClassName="flex flex-col gap-3"
    >
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        <Figure label="Posted" value={findings.posted.toLocaleString('en')} />
        <Figure
          label="Refuted before posting"
          value={findings.refuted.toLocaleString('en')}
          hint="Agent findings the verification pass showed wrong"
        />
        <Figure label="With a suggestion" value={findings.suggestions.toLocaleString('en')} />
        <Figure
          label="Refuted share"
          value={shareText(share(findings.refuted, raised))}
          hint="Refuted findings over everything the agent raised"
        />
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-2.5">
        {outcomes.comments ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">{plural(outcomes.comments, 'judged comment')}</span>
              {outcomes.acceptance !== undefined ? (
                <Tag tone={acceptanceTone(outcomes.acceptance)}>
                  {shareText(outcomes.acceptance)} accepted
                </Tag>
              ) : null}
              <Tag>{shareText(outcomes.addressed)} addressed</Tag>
              <span className="text-muted">
                {plural(outcomes.discussed, 'thread')} discussed · 👍 {outcomes.up} · 👎{' '}
                {outcomes.down}
              </span>
            </div>
            <SegmentBar segments={outcomeSegments(outcomes)} />
            <Legend
              label="Outcomes"
              items={[
                { tone: 'success', label: `fixed ${outcomes.fixed}` },
                { tone: 'info', label: `resolved ${outcomes.resolved}` },
                { tone: 'warning', label: `ignored ${outcomes.ignored}` },
                { tone: 'default', label: `unknown ${outcomes.unknown}` },
              ]}
            />
          </>
        ) : (
          <p className="text-xs text-muted">
            No judged comments in this period. Outcomes are recorded when a merge request is merged.
          </p>
        )}
      </div>
      <span className="text-xs text-muted">
        Fixed: the commented lines changed afterwards. Resolved: the thread was closed with the
        lines unchanged. Ignored: the thread stayed open. Discussed: a person replied in the thread.
      </span>
    </Panel>
  )
}

function Body({ data }: { data: ReviewAnalytics }) {
  return (
    <>
      <Strip label="Review analytics summary" cells={stripCells(data)} className="-mx-4 -mt-4" />
      <div className="grid gap-5 xl:grid-cols-2">
        <CostByPhase data={data} />
        <CostPerMergeRequest data={data} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Activity data={data} />
        <Comments data={data} />
      </div>
      {data.partial ? (
        <span className="text-xs text-muted">
          Too many review records in this period: review and comment counts cover the newest ones
          only.
        </span>
      ) : null}
    </>
  )
}

function Analytics() {
  const { view, setView, homeTeams, ready, noTeams } = useScope()
  const [period, setPeriod] = useState<AiUsagePeriodKind>('week')
  const teams = viewTeams(view, homeTeams)?.join(',') || undefined
  const scoped = ready && !noTeams && (view === 'all' || teams !== undefined)
  const analytics = useReviewAnalytics({ period, ...(teams && { teams }) }, scoped)
  const data = analytics.data
  return (
    <Page
      crumbs={[{ label: 'Review analytics' }]}
      scope={{ value: view, onChange: setView }}
      more={[copyLinkItem]}
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
          {data ? (
            <span className="text-xs text-muted">{formatDateTime(data.period.from)} – now</span>
          ) : null}
        </>
      }
    >
      {noTeams ? (
        <NoTeamsState />
      ) : analytics.isError ? (
        <ErrorState error={analytics.error} />
      ) : data ? (
        <Body data={data} />
      ) : (
        <Placeholder className="h-96" />
      )}
    </Page>
  )
}

/**
 * Ops › Review analytics (`/ops/reviews`) for `ai:read` or `ai:admin`: what merge request reviews
 * cost by phase (first review, new commits, rechecks, replies) and per merge request, how often
 * people replied and how the bot answered, and what came of the comments.
 */
export function ReviewAnalyticsPage() {
  const { can } = useSession()
  if (canReadSpend(can)) return <Analytics />
  return (
    <Page crumbs={[{ label: 'Review analytics' }]}>
      <Forbidden missing={{ action: 'ai:read' }} />
    </Page>
  )
}
