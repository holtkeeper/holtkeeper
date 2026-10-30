import { Link } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { useState } from 'react'

import { useRepos } from '../../api/queries.ts'
import { analysisPages } from '../../lib/analyses.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import { compareCounts } from '../../lib/severity.ts'
import {
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
  Table,
  Td,
  Th,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

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
        </>
      }
    >
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
          />
        ) : (
          <Table label="Repositories">
            <thead>
              <tr>
                <Th>Repository</Th>
                <Th>Groups</Th>
                <Th>Last audit</Th>
                <Th className="min-w-40">Severity</Th>
                <Th align="right">Active</Th>
                <Th align="right">Fixed</Th>
                <Th align="right">Allowlisted</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {list.map(({ repo, groups, latestAudit }) => (
                <tr key={repoKey(repo)} className="transition-colors hover:bg-default-soft">
                  <Td>
                    {latestAudit ? (
                      <Link
                        to="/audits/$runId"
                        params={{ runId: latestAudit.id }}
                        className="font-medium hover:underline"
                      >
                        {repo.path}
                      </Link>
                    ) : (
                      <span className="font-medium">{repo.path}</span>
                    )}
                    <div className="text-xs text-muted">{repo.forge}</div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {groups.map((group) => (
                        <Chip key={group}>{group}</Chip>
                      ))}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-muted">
                    {latestAudit ? (
                      <span title={formatDateTime(latestAudit.finishedAt)}>
                        {formatRelative(latestAudit.finishedAt)}
                      </span>
                    ) : (
                      'never'
                    )}
                  </Td>
                  <Td>{latestAudit ? <SeverityBar counts={latestAudit.severities} /> : null}</Td>
                  <Td align="right" className="tabular font-semibold">
                    {latestAudit?.active ?? '—'}
                  </Td>
                  <Td align="right" className="tabular text-muted">
                    {latestAudit?.resolved ?? '—'}
                  </Td>
                  <Td align="right" className="tabular text-muted">
                    {latestAudit?.ignored ?? '—'}
                    {latestAudit?.expiredAllowlist ? (
                      <span className="ml-1 text-warning">
                        ({latestAudit.expiredAllowlist} expired)
                      </span>
                    ) : null}
                  </Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      <LinkButton
                        to="/audits"
                        search={{ repo: repoKey(repo) }}
                        variant="ghost"
                        size="sm"
                      >
                        Audits
                      </LinkButton>
                      {showAnalyses
                        ? analysisPages.map((analysis) => (
                            <LinkButton
                              key={analysis.to}
                              to={analysis.to}
                              search={{ repo: repoKey(repo) }}
                              variant="ghost"
                              size="sm"
                            >
                              {analysis.title}
                            </LinkButton>
                          ))
                        : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  )
}
