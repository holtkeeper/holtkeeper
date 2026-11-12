import type { AuditRunSummary, RepoRef } from '@holtkeeper/api'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight, FileSearch } from 'lucide-react'

import { useAuditRuns, useRepos } from '../../api/queries.ts'
import { durationBetween, formatDateTime, formatRelative } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  type SecuritySearch,
  filterRuns,
  parseSecuritySearch,
  triggerLabel,
} from '../../lib/security.ts'
import {
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  Placeholder,
  Segmented,
  SeverityBar,
  Tag,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'

interface RunRow {
  run: AuditRunSummary
  groups: string[]
}

const columns = (narrowed: boolean): FleetColumn<RunRow>[] => [
  {
    id: 'repo',
    header: narrowed ? 'Finished' : 'Repository',
    className: 'min-w-56',
    cell: ({ run }) => (
      <span className="flex flex-col leading-tight">
        <span className={narrowed ? '' : 'mono text-[12.5px]'}>
          {narrowed ? formatDateTime(run.finishedAt) : run.repo.path}
        </span>
        <span className="text-[11px] text-dim" title={formatDateTime(run.finishedAt)}>
          {formatRelative(run.finishedAt)} · took {durationBetween(run.startedAt, run.finishedAt)}
        </span>
      </span>
    ),
  },
  {
    id: 'trigger',
    header: 'Trigger',
    cell: ({ run }) => (
      <span className="flex flex-col leading-tight">
        <span>{triggerLabel[run.trigger]}</span>
        {run.actor ? <span className="text-[11px] text-dim">{run.actor}</span> : null}
      </span>
    ),
  },
  {
    id: 'tools',
    header: 'Package managers',
    cell: ({ run }) => (
      <span className="flex flex-wrap gap-1">
        {run.tools.slice(0, 3).map((tool) => (
          <Tag key={tool}>{tool}</Tag>
        ))}
      </span>
    ),
  },
  {
    id: 'severity',
    header: 'Severity',
    className: 'w-40',
    cell: ({ run }) => <SeverityBar counts={run.severities} />,
  },
  {
    id: 'active',
    header: 'Active',
    align: 'right',
    cell: ({ run }) => <span className="tabular">{run.active}</span>,
  },
  {
    id: 'outcome',
    header: 'Outcome',
    cell: ({ run }) => (
      <span className="flex flex-wrap gap-1">
        {run.resolved ? (
          <Tag tone="success" dot>
            {run.resolved} fixed
          </Tag>
        ) : null}
        {run.ignored ? <Tag>{run.ignored} allowlisted</Tag> : null}
        {run.expiredAllowlist ? (
          <Tag tone="warning" dot>
            {run.expiredAllowlist} expired
          </Tag>
        ) : null}
        {!run.resolved && !run.ignored && !run.expiredAllowlist ? (
          <span className="text-dim">—</span>
        ) : null}
      </span>
    ),
  },
  {
    id: 'open',
    header: <span className="sr-only">Open</span>,
    align: 'right',
    cell: () => <ChevronRight aria-hidden className="size-4 text-muted" />,
  },
]

const triggerOptions = Object.entries(triggerLabel).map(([id, label]) => ({ id, label }))

/**
 * The Runs view: the latest audit run of each repository by default, every run with
 * `runs: 'all'` or with `repo`, filtered by trigger and by whether findings stayed active. A row
 * opens the run record.
 */
export function RunsView({
  repo,
  search,
  update,
}: {
  repo?: RepoRef
  search: SecuritySearch
  update: (patch: Partial<SecuritySearch>) => void
}) {
  const navigate = useNavigate()
  const { view, setView, homeGroups } = useScope()
  const latestOnly = !repo && search.runs !== 'all'
  const repos = useRepos()
  const runs = useAuditRuns(repo, 100, !latestOnly)
  const groupsOf = new Map(
    (repos.data?.repos ?? []).map((summary) => [repoKey(summary.repo), summary.groups]),
  )
  const source = latestOnly
    ? (repos.data?.repos ?? [])
        .flatMap((summary) => (summary.latestAudit ? [summary.latestAudit] : []))
        .toSorted((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    : (runs.data?.runs ?? [])
  const rows = filterRuns(source, search).map((run) => ({
    run,
    groups: groupsOf.get(repoKey(run.repo)) ?? [],
  }))
  const query = latestOnly ? repos : runs
  const filtered = Boolean(search.trigger || search.findings)

  if (query.isPending) return <Placeholder className="h-72" />
  if (query.isError) return <ErrorState error={query.error} />

  return (
    <FleetTable<RunRow>
      label="Audit runs"
      rows={rows}
      rowKey={(row) => row.run.id}
      columns={columns(repo !== undefined)}
      {...(repo ? {} : { scope: { value: view, onChange: setView, homeGroups } })}
      noun={{ one: 'run', many: 'runs' }}
      onOpen={(row) =>
        void navigate({ to: '/supply/security/runs/$runId', params: { runId: row.run.id } })
      }
      toolbar={
        <>
          {repo ? null : (
            <Segmented
              aria-label="Runs"
              value={latestOnly ? 'latest' : 'all'}
              onChange={(id) => update({ runs: id === 'all' ? 'all' : undefined })}
              options={[
                { id: 'latest', label: 'Latest per repository' },
                { id: 'all', label: 'All runs' },
              ]}
            />
          )}
          <FilterButton
            label="Trigger"
            options={triggerOptions}
            value={search.trigger ? [search.trigger] : []}
            onChange={(ids) =>
              update({ trigger: parseSecuritySearch({ trigger: ids.at(-1) }).trigger })
            }
          />
          <Segmented
            aria-label="Findings"
            value={search.findings ?? 'any'}
            onChange={(id) => update({ findings: parseSecuritySearch({ findings: id }).findings })}
            options={[
              { id: 'any', label: 'Any' },
              { id: 'open', label: 'With findings' },
              { id: 'clean', label: 'Clean' },
            ]}
          />
        </>
      }
      empty={
        <EmptyState
          icon={<FileSearch />}
          title={filtered ? 'No runs match' : 'No audit runs yet'}
          description={
            filtered
              ? 'Change or clear the filters to see more runs.'
              : 'Runs appear here once the CLI, a schedule or a person starts an audit.'
          }
        />
      }
    />
  )
}
