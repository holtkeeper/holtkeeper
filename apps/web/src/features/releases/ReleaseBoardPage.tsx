import type { ReleaseBatchResult, ReleaseBoardRow } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { GitPullRequestArrow, RefreshCw, Rocket, Tag } from 'lucide-react'
import { useMemo, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useReleaseActions, useReleaseBoard, useRepos } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import { countLabel, needsAttention, sortRows } from '../../lib/releases.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Loading,
  Notice,
  Page,
  Panel,
  Segmented,
  Select,
  Table,
  Td,
  Th,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { BumpChip, DeployChips, PipelineDot, ReleaseRepoLink, StageChip } from './parts.tsx'

const allGroups = '*'

type Batch = 'propose' | 'version'

function Row({
  row,
  selected,
  onSelect,
  selectable,
}: {
  row: ReleaseBoardRow
  selected: boolean
  onSelect: (selected: boolean) => void
  selectable: boolean
}) {
  return (
    <tr className="transition-colors hover:bg-default-soft">
      {selectable ? (
        <Td className="w-8">
          <Checkbox
            label={<span className="sr-only">Select {row.repo.path}</span>}
            isSelected={selected}
            onChange={onSelect}
          />
        </Td>
      ) : null}
      <Td className="min-w-56">
        <ReleaseRepoLink repo={row.repo} />
        {row.error ? <div className="mt-1 text-xs text-danger">{row.error}</div> : null}
      </Td>
      <Td>
        <StageChip stage={row.stage} />
        {row.acceptance ? (
          <div className="mt-1 text-xs text-success">accepted by {row.acceptance.by}</div>
        ) : null}
      </Td>
      <Td className="whitespace-nowrap">
        <span className="font-mono text-[13px]">{row.latest?.tag ?? 'none'}</span>
        {row.next ? (
          <>
            <span className="mx-1 text-muted">→</span>
            <span className="font-mono text-[13px] font-semibold">{row.next}</span>
            {row.bump ? (
              <span className="ml-2">
                <BumpChip bump={row.bump} />
              </span>
            ) : null}
          </>
        ) : null}
      </Td>
      <Td className="text-xs text-muted">
        {row.unreleased ? (
          <div>
            <span className="font-medium text-foreground">
              {countLabel(row.unreleased, row.unreleasedCapped)}
            </span>{' '}
            on {row.target}
            {row.waitingSince ? <> · waiting {formatRelative(row.waitingSince)}</> : null}
          </div>
        ) : null}
        {row.ahead ? (
          <div>
            <span className="font-medium text-foreground">
              {countLabel(row.ahead, row.aheadCapped)}
            </span>{' '}
            on {row.source}
          </div>
        ) : null}
        {row.tickets.length ? <div>{countLabel(row.tickets.length, false, 'ticket')}</div> : null}
        {!row.unreleased && !row.ahead ? '—' : null}
      </Td>
      <Td>
        {row.request ? (
          <a
            href={row.request.webUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm hover:underline"
          >
            !{row.request.id} {row.request.draft ? '(draft)' : ''}
          </a>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
      <Td>
        <div className="flex items-center gap-1">
          <PipelineDot label={row.source ?? 'source'} pipeline={row.pipelines.source} />
          <PipelineDot label={row.target ?? 'target'} pipeline={row.pipelines.target} />
        </div>
      </Td>
      <Td>
        <DeployChips deploy={row.deploy} />
      </Td>
    </tr>
  )
}

/** Every repository's place in its release flow, with batch steps for several at once. */
export function ReleaseBoardPage() {
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const group = typeof search.group === 'string' ? search.group : undefined
  const board = useReleaseBoard(group)
  const repos = useRepos()
  const actions = useReleaseActions()
  const { can } = useSession()
  const [filter, setFilter] = useState<'attention' | 'all'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batch, setBatch] = useState<Batch>()
  const [force, setForce] = useState(false)
  const [results, setResults] = useState<ReleaseBatchResult>()

  const groups = useMemo(
    () => [...new Set((repos.data?.repos ?? []).flatMap((repo) => repo.groups))].toSorted(),
    [repos.data],
  )
  const rows = useMemo(() => {
    const all = sortRows(board.data?.rows ?? [])
    return filter === 'attention' ? all.filter(needsAttention) : all
  }, [board.data, filter])
  const runnable = can('releases:run')
  const chosen = rows.filter((row) => selected.has(repoKey(row.repo)))
  const eligible = (step: Batch) =>
    chosen.filter((row) =>
      step === 'propose' ? row.mode === 'merge-request' && row.ahead > 0 : row.unreleased > 0,
    )

  const runBatch = () => {
    if (!batch) return
    actions.batch.mutate(
      { step: batch, repos: eligible(batch).map((row) => repoKey(row.repo)), force },
      {
        onSuccess: (result) => {
          setResults(result)
          setSelected(new Set())
          const failed = result.results.filter((entry) => !entry.ok).length
          if (failed)
            notify.error(
              `${failed} of ${result.results.length} failed`,
              'See the details in the dialog.',
            )
          else notify.success(batch === 'propose' ? 'Candidates proposed' : 'Versions created')
        },
        onError: (error) => notify.error('Not run', messageOf(error)),
      },
    )
  }

  return (
    <Page
      title="Release board"
      icon="release"
      description="Release candidates, versions waiting for acceptance and deploys across repositories"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Group"
            className="w-48"
            options={[
              { id: allGroups, label: 'All groups' },
              ...groups.map((id) => ({ id, label: id })),
            ]}
            value={group ?? allGroups}
            onChange={(id) =>
              void navigate({ to: '/release-board', search: id === allGroups ? {} : { group: id } })
            }
          />
          <Button
            variant="secondary"
            onPress={() => actions.refreshBoard.mutate(group)}
            isPending={actions.refreshBoard.isPending}
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </div>
      }
    >
      {board.data?.dryRun ? (
        <Notice tone="warning" title="Dry run">
          The server runs with dryRun: steps report what they would do and change nothing.
        </Notice>
      ) : null}
      <Panel
        title={board.data ? `${rows.length} repositories` : 'Repositories'}
        description={
          board.data ? `Read from the forges ${formatRelative(board.data.readAt)}` : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {runnable && chosen.length ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={!eligible('propose').length}
                  onPress={() => setBatch('propose')}
                >
                  <GitPullRequestArrow className="size-3.5" />
                  Propose ({eligible('propose').length})
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  isDisabled={!eligible('version').length}
                  onPress={() => setBatch('version')}
                >
                  <Tag className="size-3.5" />
                  Create versions ({eligible('version').length})
                </Button>
              </>
            ) : null}
            <Segmented
              aria-label="Filter"
              value={filter}
              onChange={setFilter}
              options={[
                { id: 'all', label: 'All' },
                { id: 'attention', label: 'Needs attention' },
              ]}
            />
          </div>
        }
      >
        {board.isPending ? (
          <Loading label="Reading release state from the forges" />
        ) : board.isError ? (
          <ErrorState error={board.error} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Rocket />}
            title={filter === 'attention' ? 'Nothing waits for you' : 'No repositories'}
            description={
              filter === 'attention'
                ? 'No version waits, no candidate is open and no deploy failed.'
                : 'Repositories of the config groups appear here; the Release flow setting can hide some.'
            }
          />
        ) : (
          <Table label="Release board">
            <thead>
              <tr>
                {runnable ? (
                  <Th>
                    <Checkbox
                      label={<span className="sr-only">Select all</span>}
                      isSelected={chosen.length === rows.length}
                      onChange={(all) =>
                        setSelected(new Set(all ? rows.map((row) => repoKey(row.repo)) : []))
                      }
                    />
                  </Th>
                ) : null}
                <Th>Repository</Th>
                <Th>Stage</Th>
                <Th>Version</Th>
                <Th>Waiting</Th>
                <Th>Candidate</Th>
                <Th>Pipelines</Th>
                <Th>Deploy</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row
                  key={repoKey(row.repo)}
                  row={row}
                  selectable={runnable}
                  selected={selected.has(repoKey(row.repo))}
                  onSelect={(on) =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (on) next.add(repoKey(row.repo))
                      else next.delete(repoKey(row.repo))
                      return next
                    })
                  }
                />
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Dialog
        isOpen={batch !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setBatch(undefined)
            setResults(undefined)
            setForce(false)
          }
        }}
        title={batch === 'propose' ? 'Propose release candidates' : 'Create versions'}
        description={`${eligible(batch ?? 'propose').length} repositories, each with its suggested version and changelog`}
        footer={
          results ? (
            <Button variant="primary" onPress={() => setBatch(undefined)}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="tertiary" onPress={() => setBatch(undefined)}>
                Cancel
              </Button>
              <Button variant="primary" onPress={runBatch} isPending={actions.batch.isPending}>
                {batch === 'propose' ? 'Propose' : 'Create versions'}
              </Button>
            </>
          )
        }
      >
        {results ? (
          <ul className="flex flex-col gap-2 text-sm">
            {results.results.map((entry) => (
              <li key={entry.repo} className="flex flex-col">
                <span className="font-medium">{entry.repo}</span>
                <span className={entry.ok ? 'text-success' : 'text-danger'}>
                  {entry.ok ? entry.result?.detail : entry.error}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <ul className="flex flex-col gap-1 text-sm">
              {eligible(batch ?? 'propose').map((row) => (
                <li key={repoKey(row.repo)}>
                  {row.repo.path}
                  {batch === 'version' && row.next ? (
                    <span className="text-muted"> → {row.next}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted">
              Each repository is checked on its own; one that fails its gates is reported and the
              others go on. Open a repository to change its version or changelog first.
            </p>
            <Checkbox
              label="Override failing pipeline, freeze, blocker and acceptance gates"
              isSelected={force}
              onChange={setForce}
            />
          </>
        )}
      </Dialog>
    </Page>
  )
}
