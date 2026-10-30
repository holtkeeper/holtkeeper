import type { RepoRef } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, GitBranch, LineChart } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'

import { useAnalyses, useAnalysisKinds, useRepos } from '../../api/queries.ts'
import { analysisPages, metricSeries, trendMetrics } from '../../lib/analyses.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { formatValue } from '../../lib/units.ts'
import { EmptyState, ErrorState, Notice, Page, Panel, Placeholder, Select } from '../../ui/index.ts'
import { Sparkline } from '../../ui/Sparkline.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { MetricChips } from './MetricChips.tsx'

const allRepos = '*'

/** One entry of `analysisPages`. */
export type AnalysisPage = (typeof analysisPages)[number]

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

/** Records of one analysis kind, newest first, with trends of its headline metrics. */
export function AnalysisRecords({ page, repo }: { page: AnalysisPage; repo?: RepoRef }) {
  const kinds = useAnalysisKinds()
  const analyses = useAnalyses(page.kind, repo)
  const list = analyses.data?.analyses ?? []
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
                />
              </Panel>
            ))}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <LineChart className="size-4" />
            Pick a repository to see how{' '}
            {trends.map((t) => t.metric.label.toLowerCase()).join(' and ')} change over time.
          </p>
        )
      ) : null}

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
                {...(repo ? { repo } : {})}
              />
            }
          />
        ) : (
          <ul className="divide-y divide-separator">
            <AnimatePresence initial={false}>
              {list.map((analysis, index) => (
                <motion.li
                  key={analysis.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0, transition: { delay: Math.min(index, 12) * 0.02 } }}
                  exit={{ opacity: 0 }}
                >
                  <Link
                    to="/analyses/$id"
                    params={{ id: analysis.id }}
                    search={{}}
                    className="grid items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-default-soft focus-visible:bg-default-soft focus-visible:outline-none md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{analysis.label}</span>
                        {analysis.ref ? (
                          <span className="truncate font-mono text-xs text-muted">
                            {analysis.ref}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted">
                        {repo ? null : `${repoKey(analysis.repo)} · `}
                        <span title={formatDateTime(analysis.createdAt)}>
                          {formatRelative(analysis.createdAt)}
                        </span>
                        {analysis.actor ? ` · ${analysis.actor}` : ''}
                      </div>
                    </div>
                    <MetricChips metrics={analysis.metrics} />
                    <ChevronRight className="hidden size-4 text-muted md:block" />
                  </Link>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Panel>
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

const [releases, bundles, , quality, ciJobs] = analysisPages

export const ReleasesPage = () => <AnalysesPage page={releases} />
export const BundlesPage = () => <AnalysesPage page={bundles} />
export const QualityPage = () => <AnalysesPage page={quality} />
export const CiJobsPage = () => <AnalysesPage page={ciJobs} />
