import type { RepoRef } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { GitBranch } from 'lucide-react'

import { useAnalyses, useAnalysisKinds, useRepos } from '../../api/queries.ts'
import { analysisPages, metricSeries, trendMetrics } from '../../lib/analyses.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { formatValue } from '../../lib/units.ts'
import { EmptyState, ErrorState, Notice, Page, Panel, Placeholder, Select } from '../../ui/index.ts'
import { Sparkline } from '../../ui/Sparkline.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { BackfillReleasesButton } from './BackfillReleases.tsx'
import { RecordRows, RepoCards } from './RecordViews.tsx'

const allRepos = '*'

/** One entry of `analysisPages`. */
export type AnalysisPage = (typeof analysisPages)[number]

/** What `AnalysisRecords` needs of a page: the kind, its title and preferred trend metrics. */
export interface AnalysisView {
  kind: string
  title: string
  trend: readonly RegExp[]
}

/** A repository picker for analysis pages: `*` stands for all repositories. */
export function RepoSelect({ to }: { to: AnalysisPage['to'] }) {
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const repos = useRepos()
  const repoParam = typeof search.repo === 'string' ? search.repo : undefined
  return (
    <Select
      aria-label="Repository"
      className="w-72"
      options={[
        { id: allRepos, label: 'All repositories' },
        ...(repos.data?.repos ?? []).map((r) => ({
          id: repoKey(r.repo),
          label: repoKey(r.repo),
        })),
      ]}
      value={repoParam ?? allRepos}
      onChange={(id) => void navigate({ to, search: id === allRepos ? {} : { repo: id } })}
    />
  )
}

/**
 * Records of one analysis kind, newest first, with trends of its headline metrics. `group`
 * targets the empty state's run button at a group for group-scoped kinds.
 */
export function AnalysisRecords({
  page,
  repo,
  group,
}: {
  page: AnalysisView
  repo?: RepoRef
  group?: string
}) {
  const kinds = useAnalysisKinds()
  const analyses = useAnalyses(page.kind, repo, repo ? 100 : 500)
  const list = analyses.data?.analyses ?? []
  const people = analyses.data?.people ?? {}
  const trends = trendMetrics(list, page.trend)
    .map((metric) => ({ metric, series: metricSeries(list, metric.id) }))
    .filter((trend) => trend.series.length > 1)
  const unknownKind = kinds.data && !kinds.data.kinds.some((k) => k.kind === page.kind)

  return (
    <div className="flex flex-col gap-6">
      {unknownKind ? (
        <Notice tone="warning" title={`This server has no “${page.kind}” analysis`}>
          Records appear here once the server supports it and something reports them.
        </Notice>
      ) : null}

      {trends.length ? (
        repo ? (
          <div className={`grid gap-4 ${trends.length > 1 ? 'md:grid-cols-2' : ''}`}>
            {trends.map(({ metric, series }, index) => (
              <Panel
                key={metric.id}
                title={metric.label}
                description={`Across ${series.length} records: ${formatValue(series[0]?.value, metric.unit)} → ${formatValue(series.at(-1)?.value, metric.unit)}`}
              >
                <Sparkline
                  points={series}
                  label={`${metric.label} across ${series.length} records`}
                  color={`var(--series-${index + 1})`}
                  height={80}
                  format={(value) => formatValue(value, metric.unit)}
                />
              </Panel>
            ))}
          </div>
        ) : null
      ) : null}

      {!repo && list.length > 0 ? (
        <RepoCards
          analyses={list}
          trend={trends[0]?.metric ?? trendMetrics(list, page.trend)[0]}
          people={people}
        />
      ) : null}

      {repo || list.length === 0 ? (
        <Panel contentClassName="p-0">
          {analyses.isPending ? (
            <div className="flex flex-col gap-2 p-4">
              {[0, 1, 2].map((i) => (
                <Placeholder key={i} className="h-14" />
              ))}
            </div>
          ) : analyses.isError ? (
            <ErrorState error={analyses.error} />
          ) : list.length === 0 ? (
            <EmptyState
              icon={<GitBranch />}
              title={`No ${page.title.toLowerCase()} yet`}
              description="Records appear after a scheduled or manual run, or when the CLI or CI reports them."
              action={
                <RunJobButton
                  analyzer={page.kind}
                  label="Run now"
                  size="sm"
                  {...(group ? { group } : repo ? { repo } : {})}
                />
              }
            />
          ) : (
            <RecordRows analyses={list} people={people} />
          )}
        </Panel>
      ) : null}
    </div>
  )
}

/** Records of one analysis kind on a page of its own. */
function AnalysesPage({ page }: { page: AnalysisPage }) {
  const search = useSearch({ strict: false })
  const repo = parseRepoKey(typeof search.repo === 'string' ? search.repo : undefined)
  return (
    <Page
      title={page.title}
      icon={page.icon}
      description={repo ? `${page.description} · ${repoKey(repo)}` : page.description}
      actions={
        <div className="flex items-center gap-2">
          <RepoSelect to={page.to} />
          {page.kind === 'changelog' ? <BackfillReleasesButton repo={repo} /> : null}
          <RunJobButton
            analyzer={page.kind}
            label="Run now"
            variant="secondary"
            {...(repo ? { repo } : {})}
          />
        </div>
      }
    >
      <AnalysisRecords page={page} {...(repo ? { repo } : {})} />
    </Page>
  )
}

const [releases, bundles, , quality, coverage, testIds, ciJobs, licenses] = analysisPages

export const ReleasesPage = () => <AnalysesPage page={releases} />
export const BundlesPage = () => <AnalysesPage page={bundles} />
export const QualityPage = () => <AnalysesPage page={quality} />
export const CoveragePage = () => <AnalysesPage page={coverage} />
export const TestIdsPage = () => <AnalysesPage page={testIds} />
export const CiJobsPage = () => <AnalysesPage page={ciJobs} />
export const LicensesPage = () => <AnalysesPage page={licenses} />
