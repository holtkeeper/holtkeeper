import type { AnalysisSummary, RepoSummary } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import {
  Bug,
  ChevronRight,
  FolderGit2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'

import { useGroups, useRepos } from '../../api/queries.ts'
import { analysisPages } from '../../lib/analyses.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { type Freshness, auditFreshness, repoKey, splitRepoPath } from '../../lib/repo.ts'
import { compareCounts } from '../../lib/severity.ts'
import {
  BrandIcon,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  LinkButton,
  Page,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  SeverityBar,
  StatCard,
  Table,
  Td,
  Th,
  Tooltip,
  stagger,
} from '../../ui/index.ts'
import { MetricChips } from '../analyses/MetricChips.tsx'
import { useSession } from '../shell/session.ts'
import { AddRepoDialog } from './AddRepoDialog.tsx'
import { RepoAvatar } from './RepoAvatar.tsx'

const orders = [
  { id: 'attention', label: 'Worst first' },
  { id: 'name', label: 'Name' },
  { id: 'recent', label: 'Recent' },
] as const

/** Every known repository with its latest audit. */
export function ReposPage() {
  const { can } = useSession()
  const showAnalyses = can('analyses:read')
  const repos = useRepos()
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState<(typeof orders)[number]['id']>('attention')
  const [adding, setAdding] = useState(false)
  const configGroups = useGroups(can('settings:read'))
  const groupIds = [
    ...new Set([
      ...(configGroups.data?.entries ?? []).map((entry) => entry.id),
      ...(repos.data?.repos ?? []).flatMap((r) => r.groups),
    ]),
  ].toSorted()
  const membersOf = (group: string) =>
    (repos.data?.repos ?? []).filter((r) => r.groups.includes(group)).length

  const needle = query.trim().toLowerCase()
  const list = (repos.data?.repos ?? [])
    .filter(
      (r) =>
        !needle ||
        repoKey(r.repo).toLowerCase().includes(needle) ||
        r.groups.some((g) => g.toLowerCase().includes(needle)),
    )
    .toSorted((a, b) => {
      if (order === 'name') return repoKey(a.repo).localeCompare(repoKey(b.repo))
      if (order === 'recent')
        return (b.latestAudit?.finishedAt ?? '').localeCompare(a.latestAudit?.finishedAt ?? '')
      if (!a.latestAudit || !b.latestAudit) return a.latestAudit ? -1 : b.latestAudit ? 1 : 0
      return (
        compareCounts(a.latestAudit.severities, b.latestAudit.severities) ||
        b.latestAudit.active - a.latestAudit.active
      )
    })

  return (
    <Page
      title="Repositories"
      icon="repos"
      description={repos.data ? `${repos.data.repos.length} known repositories` : undefined}
      actions={
        <>
          <SearchInput
            aria-label="Filter repositories"
            placeholder="Filter by path or group"
            value={query}
            onChange={setQuery}
            className="w-64"
          />
          <Segmented aria-label="Order" options={orders} value={order} onChange={setOrder} />
          {can('settings:write') ? (
            <Button variant="primary" onPress={() => setAdding(true)}>
              <Plus className="size-4" />
              Add repository
            </Button>
          ) : null}
        </>
      }
    >
      {repos.data?.repos.length ? <RepoStats repos={repos.data.repos} /> : null}
      {groupIds.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted">Groups:</span>
          {groupIds.map((group) => (
            <Link key={group} to="/repos/groups/$groupId" params={{ groupId: group }}>
              <Chip className="hover:underline">
                {group}
                <span className="text-muted">{membersOf(group)}</span>
              </Chip>
            </Link>
          ))}
        </div>
      ) : null}
      <Panel contentClassName="p-0 sm:p-2">
        {repos.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Placeholder key={i} className="h-12" />
            ))}
          </div>
        ) : repos.isError ? (
          <ErrorState error={repos.error} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<FolderGit2 />}
            title={needle ? 'No repository matches' : 'No repositories'}
            {...(!needle && can('settings:write')
              ? {
                  action: (
                    <Button variant="primary" onPress={() => setAdding(true)}>
                      Add repository
                    </Button>
                  ),
                }
              : {})}
          />
        ) : (
          <Table label="Repositories">
            <thead>
              <tr>
                <Th>Repository</Th>
                <Th className="min-w-56">Security</Th>
                <Th>Last audit</Th>
                {showAnalyses ? <Th>Analyses</Th> : null}
                <Th />
              </tr>
            </thead>
            <tbody>
              {list.map((summary) => (
                <RepoRow
                  key={repoKey(summary.repo)}
                  summary={summary}
                  showAnalyses={showAnalyses}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {adding ? <AddRepoDialog onClose={() => setAdding(false)} /> : null}
    </Page>
  )
}

const freshnessColor: Record<Freshness, string> = {
  fresh: 'var(--success)',
  aging: 'var(--warning)',
  stale: 'var(--danger)',
  never: 'var(--muted)',
}

const freshnessLabel: Record<Freshness, string> = {
  fresh: 'Audited this week',
  aging: 'Audited this month',
  stale: 'Audit is over a month old',
  never: 'Never audited',
}

function RepoStats({ repos }: { repos: readonly RepoSummary[] }) {
  const audited = repos.filter((r) => r.latestAudit)
  const fresh = audited.filter((r) => auditFreshness(r.latestAudit?.finishedAt) === 'fresh')
  const urgent = audited.filter(
    (r) => (r.latestAudit?.severities.critical ?? 0) + (r.latestAudit?.severities.high ?? 0) > 0,
  )
  const active = audited.reduce((sum, r) => sum + (r.latestAudit?.active ?? 0), 0)
  return (
    <motion.div {...stagger} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Repositories"
        value={repos.length}
        icon={<FolderGit2 />}
        accent="var(--accent)"
        hint={`${audited.length} audited, ${repos.length - audited.length} never`}
      />
      <StatCard
        label="Audited this week"
        value={fresh.length}
        icon={<ShieldCheck />}
        accent="var(--success)"
        hint={`${audited.length - fresh.length} with an older audit`}
      />
      <StatCard
        label="Critical or high"
        value={urgent.length}
        icon={<ShieldAlert />}
        accent="var(--sev-critical)"
        hint={`${plural(urgent.length, 'repository', 'repositories')} to look at first`}
      />
      <StatCard
        label="Active findings"
        value={active}
        icon={<Bug />}
        accent="var(--sev-high)"
        hint="Not fixed and not allowlisted"
      />
    </motion.div>
  )
}

function RepoRow({ summary, showAnalyses }: { summary: RepoSummary; showAnalyses: boolean }) {
  const { repo, groups, latestAudit, latestAnalyses } = summary
  const key = repoKey(repo)
  const { namespace, name } = splitRepoPath(repo.path)
  const freshness = auditFreshness(latestAudit?.finishedAt)
  const urgent = latestAudit
    ? latestAudit.severities.critical + latestAudit.severities.high > 0
    : false
  return (
    <tr className="group transition-colors hover:bg-default-soft">
      <Td className="min-w-64">
        <div className="flex items-center gap-3">
          <RepoAvatar repo={repo} />
          <div className="min-w-0">
            <Link
              to="/repos/view"
              search={{ repo: key }}
              className="block truncate hover:underline"
              title={repo.path}
            >
              <span className="text-muted">{namespace}</span>
              <span className="font-semibold">{name}</span>
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
              <span>{repo.forge}</span>
              {groups.map((group) => (
                <Link key={group} to="/repos/groups/$groupId" params={{ groupId: group }}>
                  <Chip className="hover:underline">{group}</Chip>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </Td>
      <Td>
        {latestAudit ? (
          <div className="flex items-center gap-3">
            <span
              className={`tabular w-8 text-right text-lg font-semibold ${urgent ? 'text-danger' : latestAudit.active ? '' : 'text-success'}`}
            >
              {latestAudit.active}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {latestAudit.active ? (
                <SeverityBar counts={latestAudit.severities} />
              ) : (
                <span className="flex items-center gap-1 text-xs text-success">
                  <ShieldCheck className="size-3.5" />
                  No active findings
                </span>
              )}
              <span className="text-xs text-muted">
                {latestAudit.resolved} fixed · {latestAudit.ignored} allowlisted
                {latestAudit.expiredAllowlist ? (
                  <span className="text-warning"> · {latestAudit.expiredAllowlist} expired</span>
                ) : null}
              </span>
            </div>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted">
            <ShieldQuestion className="size-3.5" />
            Not audited yet
          </span>
        )}
      </Td>
      <Td className="whitespace-nowrap">
        <Tooltip content={freshnessLabel[freshness]}>
          <span tabIndex={0} className="inline-flex items-center gap-2 text-sm">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: freshnessColor[freshness] }}
            />
            {latestAudit ? (
              <Link
                to="/audits/$runId"
                params={{ runId: latestAudit.id }}
                className="hover:underline"
                title={formatDateTime(latestAudit.finishedAt)}
              >
                {formatRelative(latestAudit.finishedAt)}
              </Link>
            ) : (
              <span className="text-muted">never</span>
            )}
          </span>
        </Tooltip>
      </Td>
      {showAnalyses ? (
        <Td>
          <div className="flex items-center gap-1">
            {analysisPages.map((page) => {
              const latest = latestAnalyses?.find((a) => a.kind === page.kind)
              return <AnalysisPill key={page.kind} page={page} repoKey={key} latest={latest} />
            })}
          </div>
        </Td>
      ) : null}
      <Td align="right">
        <div className="flex items-center justify-end gap-1">
          <LinkButton to="/audits" search={{ repo: key }} variant="ghost" size="sm">
            Audits
          </LinkButton>
          <LinkButton to="/repos/view" search={{ repo: key }} variant="ghost" size="sm">
            <ChevronRight className="size-4" />
            <span className="sr-only">Open {repo.path}</span>
          </LinkButton>
        </div>
      </Td>
    </tr>
  )
}

function AnalysisPill({
  page,
  repoKey: key,
  latest,
}: {
  page: (typeof analysisPages)[number]
  repoKey: string
  latest: AnalysisSummary | undefined
}) {
  const content = (
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-medium">{page.title}</span>
      {latest ? (
        <>
          <span className="text-muted">
            {latest.ref ? `${latest.ref} · ` : ''}
            {formatRelative(latest.createdAt)}
          </span>
          <MetricChips metrics={latest.metrics} limit={3} />
        </>
      ) : (
        <span className="text-muted">No records yet</span>
      )}
    </div>
  )
  const icon = (
    <BrandIcon name={page.icon} className={`size-6 ${latest ? '' : 'opacity-30 grayscale'}`} />
  )
  return (
    <Tooltip content={content} delay={150}>
      {latest ? (
        <Link
          to="/analyses/$id"
          params={{ id: latest.id }}
          search={{}}
          aria-label={`${page.title}: latest record`}
          className="grid size-8 place-items-center rounded-lg transition-colors hover:bg-default"
        >
          {icon}
        </Link>
      ) : (
        <Link
          to={page.to}
          search={{ repo: key }}
          aria-label={`${page.title}: no records`}
          className="grid size-8 place-items-center rounded-lg transition-colors hover:bg-default"
        >
          {icon}
        </Link>
      )}
    </Tooltip>
  )
}
