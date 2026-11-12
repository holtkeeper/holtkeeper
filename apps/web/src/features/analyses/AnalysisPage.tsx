import type { AnalysisDetail } from '@holtkeeper/api'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { GitCommitHorizontal, RotateCcw } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useAnalyses, useAnalysis, useReview } from '../../api/queries.ts'
import {
  type AnalysisSearch,
  analysisPages,
  recordRepoTab,
  splitChanges,
  stackRecords,
  trendMetrics,
  versionPoints,
} from '../../lib/analyses.ts'
import {
  durationBetween,
  formatDateTime,
  formatRef,
  formatRelative,
  shortId,
  shortSha,
} from '../../lib/format.ts'
import { jobTriggerLabel } from '../../lib/jobs.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import { patchSearch } from '../../lib/search-params.ts'
import { type Crumb, ErrorState, Page, Placeholder, Tag, UnderlineTabs } from '../../ui/index.ts'
import type { PageAction } from '../../ui/Page.tsx'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { ReportContext } from '../reports/context.ts'
import { ReportView } from '../reports/ReportView.tsx'
import { ReviewAgainDialog, useCanReview } from '../reviews/ReviewDialogs.tsx'
import { copyLinkItem } from '../shell/copy-link.ts'
import { useSession } from '../shell/session.ts'
import { RecordJobLog } from './RecordJobLog.tsx'
import { VersionChart } from './VersionChart.tsx'

const crumbsOf = (analysis: AnalysisDetail['analysis']): Crumb[] => {
  if (analysis.kind === stackRecords.kind)
    return [{ label: stackRecords.title, link: { to: stackRecords.to } }, { label: analysis.label }]
  const page = analysisPages.find((p) => p.kind === analysis.kind)
  const hub = recordRepoTab(analysis.kind)
  const repo: Crumb = {
    label: <span className="mono">{analysis.repo.path}</span>,
    link: {
      to: '/repos/$',
      params: { _splat: repoSplat(analysis.repo) },
      search: hub ?? {},
    },
  }
  return page
    ? [{ label: page.title, link: { to: page.to } }, repo, { label: 'Record' }]
    : [repo, { label: analysis.label }]
}

function Meta({ detail }: { detail: AnalysisDetail }) {
  const { analysis, previous, job, report } = detail
  const ref = report.subject?.ref ?? analysis.ref
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
      <Tag mono>{repoKey(analysis.repo)}</Tag>
      {ref ? <span className="mono">{formatRef(ref)}</span> : null}
      {analysis.sha ? (
        <span className="inline-flex items-center gap-1">
          <GitCommitHorizontal aria-hidden className="size-3.5" />
          <span className="mono text-foreground">{shortSha(analysis.sha)}</span>
        </span>
      ) : null}
      {previous ? (
        <span>
          Compared to <span className="text-foreground">{previous.label}</span>{' '}
          <span title={formatDateTime(previous.createdAt)}>
            of {formatRelative(previous.createdAt)}
          </span>
        </span>
      ) : null}
      <span title={formatDateTime(analysis.createdAt)}>
        Generated {formatRelative(analysis.createdAt)}
        {job ? ` · ${jobTriggerLabel(job.trigger)}` : analysis.actor ? ` by ${analysis.actor}` : ''}
      </span>
      {job ? (
        <span>
          <Link
            to="/ops/runs/$jobId"
            params={{ jobId: job.id }}
            className="mono text-foreground hover:underline"
          >
            {shortId(job.id)}
          </Link>
          {job.finishedAt ? (
            <span className="mono"> · {durationBetween(job.createdAt, job.finishedAt)}</span>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

function useRunAgain(detail: AnalysisDetail | undefined): {
  action: PageAction | undefined
  dialog: ReactNode
} {
  const analysis = detail?.analysis
  const isReview = analysis?.kind === 'review'
  const review = useReview(isReview ? analysis.id : undefined)
  const canReview = useCanReview()
  const [again, setAgain] = useState(false)
  const run = useRunJob({
    ...(analysis && !isReview ? { repo: analysis.repo, analyzer: analysis.kind } : {}),
    label: 'Run again',
  })
  if (!analysis) return { action: undefined, dialog: null }
  if (!isReview) return run
  const mergeRequest = review.data?.review.mergeRequest
  return {
    action:
      canReview && mergeRequest
        ? { label: 'Review again', icon: RotateCcw, onPress: () => setAgain(true) }
        : undefined,
    dialog: mergeRequest ? (
      <ReviewAgainDialog
        isOpen={again}
        onOpenChange={setAgain}
        repo={analysis.repo}
        mergeRequest={mergeRequest}
      />
    ) : null,
  }
}

/**
 * One analysis record: crumbs by kind, a version chart over the repository's records of the kind
 * (A is the compare base, B this record), and tabs for the report, its suggested changes and the
 * job log, with "Run again".
 */
export function AnalysisPage() {
  const { id } = useParams({ from: '/app/analyses/$id' })
  const search = useSearch({ from: '/app/analyses/$id' })
  const navigate = useNavigate({ from: '/analyses/$id' })
  const { can } = useSession()
  const detail = useAnalysis(id, search.compare)
  const analysis = detail.data?.analysis
  const siblings = useAnalyses(analysis?.kind ?? '', analysis?.repo, 200, analysis !== undefined)
  const again = useRunAgain(detail.data)

  if (detail.isPending || detail.isError)
    return (
      <Page crumbs={[{ label: 'Record' }]} title="Record" tabs={false}>
        {detail.isError ? (
          <ErrorState error={detail.error} />
        ) : (
          <>
            <Placeholder className="h-32" />
            <Placeholder className="h-96" />
          </>
        )}
      </Page>
    )

  const { report, previous, job } = detail.data
  const record = detail.data.analysis
  const split = splitChanges(report)
  const view =
    search.view === 'log' ? 'log' : search.view === 'changes' && split.count ? 'changes' : 'report'
  const set = (patch: Partial<AnalysisSearch>, to: string = id) =>
    void navigate({
      to: '/analyses/$id',
      params: { id: to },
      search: (prev) => patchSearch(prev, patch),
      replace: to === id,
    })

  const records = siblings.data?.analyses ?? []
  const page = analysisPages.find((p) => p.kind === record.kind)
  const metrics = trendMetrics(records, page?.trend ?? [])
  const metric = metrics.find((m) => m.id === search.metric) ?? metrics[0]
  const base = search.compare ?? previous?.id
  const points = metric ? versionPoints(records, metric, { a: base, b: id }) : []

  return (
    <Page
      crumbs={crumbsOf(record)}
      title={report.title || record.label}
      tabs={false}
      more={[copyLinkItem]}
      {...(again.action ? { primary: again.action } : {})}
    >
      <div className="flex flex-col gap-4">
        <Meta detail={detail.data} />
        {metric && points.length > 1 ? (
          <VersionChart
            points={points}
            metrics={metrics}
            metric={metric}
            onMetric={(next) => set({ metric: next === metrics[0]?.id ? undefined : next })}
            onPick={(role, picked) =>
              role === 'a'
                ? set({ compare: picked })
                : set({ compare: base === picked ? undefined : base }, picked)
            }
            {...(base ? { onSwap: () => set({ compare: id }, base) } : {})}
          />
        ) : null}
        <UnderlineTabs
          aria-label="Record views"
          items={[
            { id: 'report', label: 'Report' },
            ...(split.count
              ? [{ id: 'changes', label: 'Suggested changes', badge: split.count }]
              : []),
            { id: 'log', label: 'Job log' },
          ]}
          selected={view}
          onSelect={(next) =>
            set({ view: next === 'log' ? 'log' : next === 'changes' ? 'changes' : undefined })
          }
        />
        <div
          className={
            detail.isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'
          }
        >
          {view === 'log' ? (
            <RecordJobLog job={job} />
          ) : (
            <ReportContext
              value={{
                analysisId: id,
                canApply: can('analyses:run'),
                ...(report.exclude && report.subject?.repo && can('settings:write')
                  ? { exclude: { ...report.exclude, repo: report.subject.repo } }
                  : {}),
              }}
            >
              <ReportView
                header={false}
                report={
                  view === 'changes'
                    ? { ...split.report, metrics: [], sections: split.changes }
                    : split.report
                }
              />
            </ReportContext>
          )}
        </div>
      </div>
      {again.dialog}
    </Page>
  )
}
