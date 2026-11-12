import type { BranchesRepoRow } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { CheckCheck, ExternalLink, GitBranch, X } from 'lucide-react'

import {
  type BranchListRow,
  type BranchPanel,
  authorTotals,
  branchChanges,
  branchKpis,
  branchPanels,
  selectionByRepo,
  selectionText,
  signed,
} from '../../lib/branches.ts'
import { plural } from '../../lib/format.ts'
import { repoSplat } from '../../lib/repo.ts'
import { CopyButton, EmptyState, KeyValue, SideSheet, Table, Td, Th } from '../../ui/index.ts'

const panelLabels: Record<BranchPanel, string> = {
  selection: 'Selection',
  authors: 'By author',
  changes: 'Since last run',
}

const deltaClass = (value: number) => (value > 0 ? 'text-bad' : value < 0 ? 'text-ok' : 'text-dim')

function Delta({ value }: { value: number }) {
  return <span className={`tabular mono ${deltaClass(value)}`}>{signed(value)}</span>
}

function HubLink({ row }: { row: Pick<BranchesRepoRow, 'repo'> }) {
  return (
    <Link
      to="/repos/$"
      params={{ _splat: repoSplat(row.repo) }}
      search={{ tab: 'quality', section: 'branches' }}
      className="mono text-[12.5px] hover:underline"
    >
      {row.repo.path}
    </Link>
  )
}

function Selection({
  rows,
  selected,
  staleDays,
}: {
  rows: readonly BranchListRow[]
  selected: ReadonlySet<string>
  staleDays: readonly number[]
}) {
  const groups = selectionByRepo(rows, selected)
  if (!groups.length)
    return (
      <EmptyState
        icon={<GitBranch />}
        title="Nothing selected"
        description="Pick branches in the table to list them here by repository with links to the forge."
      />
    )
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">By repository</h3>
        <CopyButton text={() => selectionText(groups)} variant="ghost">
          Copy list
        </CopyButton>
      </div>
      <Table label="Selected branches by repository">
        <thead>
          <tr>
            <Th>Repository</Th>
            <Th>Branches</Th>
            <Th align="right">Count</Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.repoKey}>
              <Td valign="top">
                <HubLink row={group} />
              </Td>
              <Td>
                <ul className="flex flex-col gap-0.5">
                  {group.branches.map((branch) => (
                    <li key={branch.key} className="mono text-[12px]">
                      {branch.webUrl ? (
                        <a
                          href={branch.webUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          {branch.name}
                          <ExternalLink aria-hidden className="size-3 text-dim" />
                        </a>
                      ) : (
                        branch.name
                      )}
                    </li>
                  ))}
                </ul>
              </Td>
              <Td align="right" valign="top" className="tabular">
                {group.branches.length}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-xs text-muted">
        Holtkeeper does not delete branches. Delete them on the forge; protected branches and
        branches with an open merge request are never listed.
      </p>
      <KeyValue
        rows={[
          {
            label: 'Stale after',
            value: staleDays.length
              ? staleDays.map((days) => plural(days, 'day')).join(', ')
              : null,
          },
        ]}
      />
    </div>
  )
}

function Authors({ repos }: { repos: readonly BranchesRepoRow[] }) {
  const authors = authorTotals(repos)
  if (!authors.length) return <EmptyState icon={<GitBranch />} title="No branches to clean up" />
  return (
    <Table label="Branches to clean up by author">
      <thead>
        <tr>
          <Th>Author</Th>
          <Th align="right">Branches</Th>
          <Th align="right">Merged</Th>
          <Th align="right">Closed MR</Th>
          <Th align="right">Stale</Th>
          <Th align="right">Oldest</Th>
        </tr>
      </thead>
      <tbody>
        {authors.map((author) => (
          <tr key={author.author}>
            <Td className={author.author === 'unknown' ? 'text-muted' : ''}>
              {author.author === 'unknown' ? 'Unknown' : author.author}
            </Td>
            <Td align="right" className="tabular font-medium">
              {author.cleanup}
            </Td>
            <Td align="right" className="tabular">
              {author.merged}
            </Td>
            <Td align="right" className="tabular">
              {author.closed}
            </Td>
            <Td align="right" className="tabular">
              {author.stale}
            </Td>
            <Td align="right" className="tabular mono text-muted">
              {author.oldestDays}d
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function Changes({ repos }: { repos: readonly BranchesRepoRow[] }) {
  const kpi = branchKpis(repos)
  const changes = branchChanges(repos)
  if (!kpi.compared)
    return (
      <EmptyState
        icon={<GitBranch />}
        title="No previous run yet"
        description="Changes show once a repository has been analyzed twice."
      />
    )
  return (
    <div className="flex flex-col gap-4">
      <KeyValue
        rows={[
          {
            label: 'To clean up',
            value: (
              <span>
                <Delta value={kpi.delta ?? 0} />{' '}
                <span className="text-muted">
                  across {plural(kpi.compared, 'repository', 'repositories')} with a previous run
                </span>
              </span>
            ),
          },
        ]}
      />
      {changes.length ? (
        <Table label="Changes since the previous run by repository">
          <thead>
            <tr>
              <Th>Repository</Th>
              <Th align="right">To clean up</Th>
              <Th align="right">Merged</Th>
              <Th align="right">Closed MR</Th>
              <Th align="right">Stale</Th>
              <Th align="right">Branches</Th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change) => (
              <tr key={change.repoKey}>
                <Td>
                  <HubLink row={change} />
                </Td>
                <Td align="right">
                  <Delta value={change.delta.cleanup} />
                </Td>
                <Td align="right">
                  <Delta value={change.delta.merged} />
                </Td>
                <Td align="right">
                  <Delta value={change.delta.closed} />
                </Td>
                <Td align="right">
                  <Delta value={change.delta.stale} />
                </Td>
                <Td align="right">
                  <Delta value={change.delta.total} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-xs text-muted">Nothing changed since the previous runs.</p>
      )}
    </div>
  )
}

/**
 * The Branches side sheet, read-only: the selected branches by repository with links to the
 * forge, branches to clean up per author, and the change of every count since each repository's
 * previous run.
 */
export function BranchesSheet({
  open,
  panel,
  onPanel,
  onClose,
  rows,
  repos,
  selected,
  onSelectMergedClosed,
  onClear,
}: {
  open: boolean
  panel: BranchPanel
  onPanel: (panel: BranchPanel) => void
  onClose: () => void
  /** Rows the selection is taken from. */
  rows: readonly BranchListRow[]
  /** Repositories in scope, for the author and change panels. */
  repos: readonly BranchesRepoRow[]
  selected: ReadonlySet<string>
  onSelectMergedClosed: () => void
  onClear: () => void
}) {
  if (!open) return null
  const kpi = branchKpis(repos)
  const groups = selectionByRepo(rows, selected)
  const count = groups.reduce((sum, group) => sum + group.branches.length, 0)
  return (
    <SideSheet
      open
      onClose={onClose}
      id="Branches"
      title={
        count
          ? `${plural(count, 'branch', 'branches')} in ${plural(groups.length, 'repository', 'repositories')}`
          : `${kpi.cleanup} to clean up`
      }
      quietActions={[
        { label: 'Select merged and closed', icon: CheckCheck, onPress: onSelectMergedClosed },
        { label: 'Clear selection', icon: X, onPress: onClear },
      ]}
      tabs={{
        items: branchPanels.map((id) => ({
          id,
          label: panelLabels[id],
          ...(id === 'selection' && count ? { badge: count } : {}),
          ...(id === 'changes' && kpi.delta !== undefined ? { badge: signed(kpi.delta) } : {}),
        })),
        selected: panel,
        onSelect: (id) => onPanel(branchPanels.find((entry) => entry === id) ?? 'selection'),
        'aria-label': 'Branch details',
      }}
    >
      {panel === 'selection' ? (
        <Selection rows={rows} selected={selected} staleDays={kpi.staleDays} />
      ) : panel === 'authors' ? (
        <Authors repos={repos} />
      ) : (
        <Changes repos={repos} />
      )}
    </SideSheet>
  )
}
