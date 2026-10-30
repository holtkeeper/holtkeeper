import { Link } from '@tanstack/react-router'
import { CircleCheck, FolderGit2, Package, ShieldAlert } from 'lucide-react'
import { motion } from 'motion/react'
import { useMemo, useState } from 'react'

import { useAuditRunDetails, useAuditRuns, useRepos } from '../../api/queries.ts'
import {
  activeTrend,
  breakdown,
  breakdownFromSummaries,
  latestTotals,
  needsAttention,
  topPackages,
} from '../../lib/dashboard.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import { severities, severityLabel } from '../../lib/severity.ts'
import {
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  Segmented,
  SeverityBar,
  SeverityChip,
  StatCard,
  fadeItem,
  languageColor,
  severityColor,
  stagger,
} from '../../ui/index.ts'
import { BarList } from './BarList.tsx'
import { TrendChart } from './TrendChart.tsx'

const ranges = [
  { id: '14', label: '14 d' },
  { id: '30', label: '30 d' },
  { id: '90', label: '90 d' },
] as const

const detailLimit = 40

/** Overview of the latest audit of every repository. */
export function DashboardPage() {
  const repos = useRepos()
  const runs = useAuditRuns(undefined, 500)
  const [range, setRange] = useState<(typeof ranges)[number]['id']>('30')

  const repoList = useMemo(() => repos.data?.repos ?? [], [repos.data])
  const latest = useMemo(
    () => repoList.flatMap((r) => (r.latestAudit ? [r.latestAudit] : [])),
    [repoList],
  )
  const details = useAuditRunDetails(latest.slice(0, detailLimit))
  const reports = details.flatMap((d) =>
    d.data ? [{ repo: repoKey(d.data.run.repo), report: d.data.run.report }] : [],
  )
  const detailsReady = details.length > 0 && details.every((d) => d.isSuccess)

  const totals = latestTotals(repoList)
  const trend = useMemo(() => activeTrend(runs.data?.runs ?? [], Number(range)), [runs.data, range])
  const slices =
    detailsReady && latest.length <= detailLimit
      ? breakdown(reports.map((r) => r.report))
      : breakdownFromSummaries(latest)
  const sliceUnit = detailsReady && latest.length <= detailLimit ? 'findings' : 'repos'
  const packages = topPackages(reports)
  const attention = needsAttention(repoList)

  if (repos.isError)
    return (
      <Page title="Dashboard">
        <ErrorState error={repos.error} />
      </Page>
    )

  return (
    <Page
      title="Dashboard"
      icon="holtkeeper"
      description={
        repos.data
          ? `${plural(latest.length, 'repository', 'repositories')} audited of ${repoList.length} known`
          : 'Latest audit of every repository'
      }
    >
      {repos.isPending ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Placeholder key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <motion.div {...stagger} className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {severities.slice(0, 4).map((severity) => (
            <StatCard
              key={severity}
              label={severityLabel[severity]}
              value={totals[severity]}
              accent={severityColor(severity)}
              icon={<ShieldAlert />}
              hint={
                severity === 'critical' && totals.unknown
                  ? `${totals.unknown} with unknown severity`
                  : undefined
              }
            />
          ))}
        </motion.div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Active findings"
          description="Sum of every repository's latest audit, per day"
          actions={
            <Segmented aria-label="Time range" options={ranges} value={range} onChange={setRange} />
          }
        >
          {runs.isPending ? (
            <Placeholder className="h-64" />
          ) : runs.isError ? (
            <ErrorState error={runs.error} />
          ) : (
            <TrendChart points={trend} />
          )}
        </Panel>
        <Panel title="Status" description="Across latest audits">
          <div className="flex flex-col gap-4">
            <SeverityBar counts={totals} height="h-3" showLegend />
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Active', totals.active],
                ['Fixed in last runs', totals.resolved],
                ['Allowlisted', totals.ignored],
                ['Expired allowlist', totals.expiredAllowlist],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-default-soft p-3">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="tabular mt-0.5 text-lg font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="By language"
          description={sliceUnit === 'repos' ? 'Repositories with findings' : 'Active findings'}
        >
          {slices.languages.length ? (
            <BarList items={slices.languages} unit={sliceUnit} colorOf={languageColor} />
          ) : (
            <EmptyState icon={<CircleCheck />} title="Nothing to show" />
          )}
        </Panel>
        <Panel
          title="By package manager"
          description={sliceUnit === 'repos' ? 'Repositories with findings' : 'Active findings'}
        >
          {slices.tools.length ? (
            <BarList items={slices.tools.slice(0, 8)} unit={sliceUnit} />
          ) : (
            <EmptyState icon={<CircleCheck />} title="Nothing to show" />
          )}
        </Panel>
        <Panel title="Most affected packages" description="Across latest audits">
          {packages.length ? (
            <ul className="flex flex-col divide-y divide-separator">
              {packages.map((pkg) => (
                <li
                  key={`${pkg.ecosystem}|${pkg.name}`}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Package className="size-4 shrink-0 text-muted" />
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[13px]">{pkg.name}</div>
                      <div className="text-xs text-muted">
                        {pkg.ecosystem} · {plural(pkg.repos, 'repo')}
                      </div>
                    </div>
                  </div>
                  <SeverityChip severity={pkg.worst} count={pkg.findings} compact />
                </li>
              ))}
            </ul>
          ) : details.some((d) => d.isPending) ? (
            <Placeholder className="h-40" />
          ) : (
            <EmptyState icon={<CircleCheck />} title="No vulnerable packages" />
          )}
        </Panel>
      </div>

      <Panel
        title="Needs attention"
        description="Repositories with active findings or expired allowlist entries, worst first"
      >
        {attention.length ? (
          <motion.ul {...stagger} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {attention.map(({ repo, latestAudit }) => (
              <motion.li key={repoKey(repo)} {...fadeItem}>
                <Link
                  to="/audits/$runId"
                  params={{ runId: latestAudit!.id }}
                  className="flex flex-col gap-3 rounded-2xl border border-border p-4 transition hover:border-border-tertiary hover:bg-default-soft focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{repo.path}</div>
                      <div className="text-xs text-muted">
                        {repo.forge} · {formatRelative(latestAudit!.finishedAt)}
                      </div>
                    </div>
                    <span className="tabular text-lg font-semibold">{latestAudit!.active}</span>
                  </div>
                  <SeverityBar counts={latestAudit!.severities} />
                  {latestAudit!.expiredAllowlist ? (
                    <div className="text-xs text-warning">
                      {plural(
                        latestAudit!.expiredAllowlist,
                        'expired allowlist entry',
                        'expired allowlist entries',
                      )}
                    </div>
                  ) : null}
                </Link>
              </motion.li>
            ))}
          </motion.ul>
        ) : repos.isPending ? (
          <Placeholder className="h-32" />
        ) : (
          <EmptyState
            icon={latest.length ? <CircleCheck /> : <FolderGit2 />}
            title={latest.length ? 'All clear' : 'No audits yet'}
            description={
              latest.length
                ? 'No repository has active findings.'
                : 'Run `holtkeeper audit` or wait for the schedule to see results here.'
            }
          />
        )}
      </Panel>
    </Page>
  )
}
