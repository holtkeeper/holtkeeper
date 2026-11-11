import { type RepoOverview as Overview, type RepoRef, formatBytes } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { useRepoAssets, useRepoOverview } from '../../api/queries.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import {
  freshnessRows,
  recordFreshnessLabel,
  recordFreshnessTone,
  stackHealth,
} from '../../lib/repo-page.ts'
import { repoKey } from '../../lib/repo.ts'
import { supportLabel, supportTone } from '../../lib/stack.ts'
import { formatValue } from '../../lib/units.ts'
import type { StatusTone } from '../../ui/colors.ts'
import { ErrorState, Placeholder, SeverityBar, Tag } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { RepoCoverageCard } from '../test-coverage/CoverageCard.tsx'

const shortSha = (sha: string) => sha.slice(0, 8)

function Card({
  title,
  status,
  link,
  children,
}: {
  title: string
  status?: { tone: StatusTone; label: string }
  link?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5">
      <header className="flex items-start justify-between gap-2">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {status ? (
          <Tag tone={status.tone} dot>
            {status.label}
          </Tag>
        ) : null}
      </header>
      <div className="flex flex-1 flex-col gap-2 text-sm">{children}</div>
      {link}
    </section>
  )
}

const linkClass =
  'inline-flex items-center gap-1 self-start text-xs font-medium text-[var(--brand)] hover:underline'

function AssetsCard({ repo, onOpen }: { repo: RepoRef; onOpen: () => void }) {
  const assets = useRepoAssets(repo)
  if (assets.isPending) return <Placeholder className="h-40" />
  if (assets.isError) return <ErrorState error={assets.error} />
  const { summary, createdAt } = assets.data
  const open = (
    <button type="button" onClick={onOpen} className={linkClass}>
      Assets tab
      <ArrowRight className="size-3" />
    </button>
  )
  if (!summary)
    return (
      <Card title="Assets" link={open}>
        <span className="text-muted">No assets record yet.</span>
      </Card>
    )
  return (
    <Card
      title="Assets"
      status={
        summary.errors
          ? { tone: 'danger', label: plural(summary.errors, 'error') }
          : summary.warnings
            ? { tone: 'warning', label: plural(summary.warnings, 'warning') }
            : { tone: 'success', label: 'within policy' }
      }
      link={open}
    >
      <div className="flex items-baseline gap-2">
        <span className="mono text-[15px] font-semibold">{formatBytes(summary.totalBytes)}</span>
        <span className="text-xs text-muted">in {plural(summary.files, 'file')}</span>
      </div>
      <span className="text-xs text-muted">
        {summary.savings ? (
          <>
            could save <span className="mono">{formatBytes(summary.savings)}</span>
          </>
        ) : (
          'nothing to shrink'
        )}
        {createdAt ? ` · checked ${formatRelative(createdAt)}` : ''}
      </span>
    </Card>
  )
}

function DependenciesCard({ repo, overview }: { repo: RepoRef; overview: Overview }) {
  const { audit, dependencies } = overview
  const severe = audit ? audit.severities.critical + audit.severities.high : 0
  return (
    <Card
      title="Dependencies"
      {...(audit
        ? {
            status: audit.active
              ? {
                  tone: severe ? ('danger' as const) : ('warning' as const),
                  label: plural(audit.active, 'vulnerability', 'vulnerabilities'),
                }
              : { tone: 'success' as const, label: 'no known vulnerabilities' },
          }
        : {})}
      link={
        <div className="flex flex-wrap gap-3">
          <Link to="/dependencies" search={{ repo: repoKey(repo) }} className={linkClass}>
            Dependencies
            <ArrowRight className="size-3" />
          </Link>
          {audit ? (
            <Link to="/audits/$runId" params={{ runId: audit.id }} className={linkClass}>
              Latest audit
              <ArrowRight className="size-3" />
            </Link>
          ) : null}
        </div>
      }
    >
      {dependencies ? (
        <span>
          <span className="mono font-semibold">{dependencies.direct}</span>{' '}
          <span className="text-muted">direct, read {formatRelative(dependencies.createdAt)}</span>
        </span>
      ) : (
        <span className="text-muted">No dependency graph yet.</span>
      )}
      {audit ? (
        <>
          <SeverityBar counts={audit.severities} />
          <span className="text-xs text-muted">
            audited {formatRelative(audit.finishedAt)}
            {audit.ignored ? `, ${audit.ignored} allowlisted` : ''}
          </span>
        </>
      ) : null}
    </Card>
  )
}

function StackCard({ overview }: { overview: Overview }) {
  const { stack } = overview
  const [group] = overview.groups
  const link = group ? (
    <Link
      to="/repos/groups/$groupId"
      params={{ groupId: group }}
      search={{ tab: 'stack' }}
      className={linkClass}
    >
      Stack of {group}
      <ArrowRight className="size-3" />
    </Link>
  ) : (
    <Link to="/stack" className={linkClass}>
      Stack
      <ArrowRight className="size-3" />
    </Link>
  )
  if (!stack)
    return (
      <Card title="Stack" link={link}>
        <span className="text-muted">Not in a stack record yet.</span>
      </Card>
    )
  const health = stackHealth(stack)
  const failing = stack.conventions.drifts + stack.conventions.missing
  return (
    <Card
      title="Stack"
      status={{
        tone: health.tone,
        label: health.ending
          ? `${health.ending} ending`
          : failing
            ? plural(failing, 'convention drift')
            : 'supported',
      }}
      link={link}
    >
      <ul className="flex flex-col gap-1">
        {stack.tools.slice(0, 5).map((tool) => (
          <li
            key={`${tool.id}:${tool.file}:${tool.declared}`}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="min-w-0 truncate" title={tool.file}>
              {tool.name} <span className="mono text-muted">{tool.declared}</span>
            </span>
            <Tag tone={supportTone(tool.support)}>{supportLabel[tool.support]}</Tag>
          </li>
        ))}
      </ul>
      {stack.tools.length > 5 ? (
        <span className="text-xs text-dim">{stack.tools.length - 5} more</span>
      ) : null}
      <span className="text-xs text-muted">
        conventions: {stack.conventions.matches} match
        {failing ? `, ${failing} drift or missing` : ''}
      </span>
    </Card>
  )
}

function ReleaseCard({ repo }: { repo: RepoRef }) {
  return (
    <Card
      title="Releases"
      link={
        <Link to="/releases/$" params={{ _splat: repoKey(repo) }} className={linkClass}>
          Release timeline
          <ArrowRight className="size-3" />
        </Link>
      }
    >
      <span className="text-muted">
        Versions, what changed since the last tag, the next release and its deploys.
      </span>
    </Card>
  )
}

function FreshnessCard({ repo, overview }: { repo: RepoRef; overview: Overview }) {
  const rows = freshnessRows(overview)
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3.5 sm:col-span-2 xl:col-span-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Analyses</h2>
        <span className="text-xs text-muted">
          {overview.head ? (
            <>
              HEAD <span className="mono">{shortSha(overview.head.sha)}</span> since{' '}
              {formatRelative(overview.head.at)}
            </>
          ) : (
            'default-branch head not seen yet'
          )}
          {' · '}
          <Link to="/jobs" search={{ repo: repoKey(repo) }} className="hover:underline">
            jobs
          </Link>
        </span>
      </header>
      {rows.length ? (
        <ul className="flex flex-col divide-y divide-line">
          {rows.map(({ record, freshness }) => (
            <li key={record.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
              <Link
                to="/analyses/$id"
                params={{ id: record.id }}
                className="min-w-40 text-sm font-medium hover:underline"
              >
                {record.label}
              </Link>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {record.metrics
                  .slice(0, 2)
                  .map((metric) => `${metric.label} ${formatValue(metric.value, metric.unit)}`)
                  .join(' · ')}
              </span>
              <span className="text-xs text-muted" title={formatDateTime(record.createdAt)}>
                {record.sha ? <span className="mono">{shortSha(record.sha)} </span> : null}
                {formatRelative(record.createdAt)}
              </span>
              <Tag tone={recordFreshnessTone[freshness]} dot>
                {recordFreshnessLabel[freshness]}
              </Tag>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-sm text-muted">Nothing analyzed yet.</span>
      )}
    </section>
  )
}

/** The repository's analysis cards: coverage, assets, dependencies, stack, releases, freshness. */
export function RepoOverview({ repo, onAssets }: { repo: RepoRef; onAssets: () => void }) {
  const { can } = useSession()
  const overview = useRepoOverview(repo)
  if (overview.isPending)
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Placeholder className="h-40" />
        <Placeholder className="h-40" />
        <Placeholder className="h-40" />
      </div>
    )
  if (overview.isError) return <ErrorState error={overview.error} />
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <RepoCoverageCard repo={repo} />
      <AssetsCard repo={repo} onOpen={onAssets} />
      <DependenciesCard repo={repo} overview={overview.data} />
      <StackCard overview={overview.data} />
      {can('releases:read') ? <ReleaseCard repo={repo} /> : null}
      <FreshnessCard repo={repo} overview={overview.data} />
    </div>
  )
}
