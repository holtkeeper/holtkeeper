import type { LibraryIndexRun, LibrarySummary } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Bot, LibraryBig, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useGitHubTokens, useLibraryIndex, useReindexLibraries } from '../../api/queries.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { type GitHubRange, defaultGitHubRange } from '../../lib/github-usage.ts'
import {
  type LibraryEcosystem,
  libraryEcosystems,
  libraryListQuery,
  runSummary,
  sourceLabel,
} from '../../lib/libraries.ts'
import { libraryTools } from '../../lib/mcp.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Notice,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  StatCard,
  Table,
  Td,
  Th,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { GitHubUsageSection, usageHidden } from '../credentials/GitHubUsage.tsx'
import { useSession } from '../shell/session.ts'
import { IndexCoverage, RunningIndex } from './IndexStatus.tsx'

const shownVersions = 4

function AgentToolsNote() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-sm">
      <Bot className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <p className="text-muted">
        Agents read these docs through the MCP tools{' '}
        {libraryTools.map((tool, index) => (
          <span key={tool}>
            <code className="mono rounded bg-raise px-1 py-0.5 text-xs text-foreground">
              {tool}
            </code>
            {index < libraryTools.length - 1 ? ', ' : ''}
          </span>
        ))}
        , answering for the version the asking repository uses. Developers find the same docs on
        each library of the{' '}
        <Link to="/dependencies" className="text-foreground hover:underline">
          Dependencies
        </Link>{' '}
        page.
      </p>
    </div>
  )
}

/**
 * The library index admin for Settings → System: what is indexed for agents, the run going on,
 * coverage per source, the last run's failures and GitHub API usage. Global `settings:read`.
 */
export function LibraryIndex() {
  const { canGlobal } = useSession()
  const [query, setQuery] = useState('')
  const [ecosystem, setEcosystem] = useState<LibraryEcosystem | 'all'>('all')
  const debounced = useDebounced(query, 300)
  const filter = libraryListQuery({ q: debounced, ecosystem })
  const libraries = useLibraryIndex(filter)
  const reindex = useReindexLibraries()
  const [days, setDays] = useState<GitHubRange>(defaultGitHubRange)
  const github = useGitHubTokens(days)
  const data = libraries.data

  if (libraries.isPending)
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Placeholder key={index} className="h-24" />
          ))}
        </div>
        <Placeholder className="h-96" />
      </div>
    )
  if (libraries.isError) return <ErrorState error={libraries.error} />
  if (!data?.enabled)
    return (
      <EmptyState
        icon={<LibraryBig />}
        title="Library indexing is off"
        description="Turn on the libraries setting (enabled: true) and run the server with a store that keeps libraries. The indexer then fetches docs, release notes and APIs of every library the repositories resolve, plus the versions an upgrade would land on."
      />
    )
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Library index</h2>
        {canGlobal('analyses:run') ? (
          <Button
            variant="secondary"
            size="sm"
            isPending={reindex.isPending}
            onPress={() =>
              reindex.mutate(undefined, {
                onSuccess: (result) =>
                  result.started
                    ? notify.success('Indexing started', 'The list refreshes once the run is done.')
                    : notify.info('A run is already going'),
                onError: (error) => notify.error('Not started', messageOf(error)),
              })
            }
          >
            <RefreshCw className="size-3.5" />
            Reindex now
          </Button>
        ) : null}
      </div>
      <Totals libraries={data.libraries} />
      <AgentToolsNote />
      {data.progress ? <RunningIndex progress={data.progress} /> : null}
      {data.lastRun ? <LastRun run={data.lastRun} /> : null}
      <IndexCoverage coverage={data.coverage} />
      {usageHidden(github.error) ? null : (
        <GitHubUsageSection days={days} onDaysChange={setDays} usage={github} />
      )}
      <Panel
        title="Indexed libraries"
        description={
          filter.q || filter.ecosystem
            ? `${plural(data.libraries.length, 'library', 'libraries')} match`
            : 'Every library the index keeps'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              aria-label="Ecosystem"
              value={ecosystem}
              onChange={setEcosystem}
              options={[{ id: 'all', label: 'All' }, ...libraryEcosystems]}
            />
            <SearchInput
              aria-label="Search libraries"
              placeholder="Filter by name"
              value={query}
              onChange={setQuery}
              className="w-64"
            />
          </div>
        }
      >
        {data.libraries.length ? (
          <Table label="Libraries">
            <thead>
              <tr>
                <Th>Library</Th>
                <Th>Ecosystem</Th>
                <Th>Latest</Th>
                <Th>Indexed versions</Th>
                <Th align="right">Repos</Th>
                <Th align="right">Chunks</Th>
                <Th align="right">Issues</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {data.libraries.map((library) => (
                <LibraryRow key={`${library.ecosystem}:${library.name}`} library={library} />
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={<LibraryBig />}
            title={filter.q || filter.ecosystem ? 'No library matches' : 'Nothing indexed yet'}
            description={
              filter.q || filter.ecosystem
                ? 'Try part of the name or another ecosystem.'
                : 'The indexer runs after depgraph and usages records change and once a day; repositories need one of those records first.'
            }
          />
        )}
      </Panel>
    </div>
  )
}

function Totals({ libraries }: { libraries: LibrarySummary[] }) {
  const versions = libraries.reduce((sum, library) => sum + library.versions.length, 0)
  const chunks = libraries.reduce((sum, library) => sum + library.chunks, 0)
  const failing = libraries.filter((library) => library.failed.length).length
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Libraries" value={libraries.length} icon={<LibraryBig />} />
      <StatCard label="Indexed versions" value={versions} hint="used and upgrade targets" />
      <StatCard label="Document sections" value={chunks} hint="searchable by agents" />
      <StatCard
        label="With failed sources"
        value={failing}
        hint="retried on the next run"
        {...(failing ? { accent: 'var(--warning)' } : {})}
      />
    </div>
  )
}

function LastRun({ run }: { run: LibraryIndexRun }) {
  const at = run.finishedAt ?? run.startedAt
  return (
    <Panel
      title="Last indexing run"
      description={
        <Tooltip content={formatDateTime(at)}>
          <span tabIndex={0}>
            {run.finishedAt ? 'Finished' : 'Started'} {formatRelative(at)}
          </span>
        </Tooltip>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p>{runSummary(run)}</p>
        {run.error ? (
          <Notice tone="danger" title="The run stopped">
            {run.error}
          </Notice>
        ) : null}
        {run.failures.length ? (
          <details className="rounded-xl border border-border">
            <summary className="cursor-pointer px-3 py-2 text-warning">
              {plural(run.failures.length, 'failed source')}
            </summary>
            <Table label="Failed sources">
              <thead>
                <tr>
                  <Th>Library</Th>
                  <Th>Version</Th>
                  <Th>Source</Th>
                  <Th>Message</Th>
                </tr>
              </thead>
              <tbody>
                {run.failures.map((failure, index) => (
                  <tr
                    key={`${failure.library} ${failure.version ?? ''} ${failure.source} ${index}`}
                  >
                    <Td className="font-mono text-[13px]">{failure.library}</Td>
                    <Td className="tabular">{failure.version ?? '—'}</Td>
                    <Td>{sourceLabel(failure.source)}</Td>
                    <Td className="max-w-[32rem] break-words text-muted">{failure.message}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        ) : null}
      </div>
    </Panel>
  )
}

function LibraryRow({ library }: { library: LibrarySummary }) {
  const rest = library.versions.length - shownVersions
  return (
    <tr className="hover:bg-default/40">
      <Td className="max-w-[24rem]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-medium">{library.name}</span>
          {library.failed.length ? (
            <Tooltip content={`Last fetch failed: ${library.failed.map(sourceLabel).join(', ')}`}>
              <span tabIndex={0} className="inline-flex">
                <Chip tone="warning">
                  <AlertTriangle className="size-3" />
                  {plural(library.failed.length, 'failed source')}
                </Chip>
              </span>
            </Tooltip>
          ) : null}
        </div>
        {library.description ? (
          <div className="mt-0.5 truncate text-xs text-muted">{library.description}</div>
        ) : null}
      </Td>
      <Td>
        <Chip>{library.ecosystem}</Chip>
      </Td>
      <Td className="tabular">{library.latest ?? '—'}</Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          {library.versions.slice(0, shownVersions).map((version) => (
            <Chip key={version} tone={version === library.latest ? 'success' : 'default'}>
              {version}
            </Chip>
          ))}
          {rest > 0 ? (
            <Tooltip content={library.versions.slice(shownVersions).join(', ')}>
              <span tabIndex={0} className="inline-flex">
                <Chip variant="tertiary">+{rest}</Chip>
              </span>
            </Tooltip>
          ) : null}
        </div>
      </Td>
      <Td align="right" className="tabular">
        {library.repos}
      </Td>
      <Td align="right" className="tabular">
        {library.chunks}
      </Td>
      <Td align="right" className="tabular">
        {library.issues}
      </Td>
      <Td className="whitespace-nowrap text-muted">
        <Tooltip content={formatDateTime(library.updatedAt)}>
          <span tabIndex={0}>{formatRelative(library.updatedAt)}</span>
        </Tooltip>
      </Td>
    </tr>
  )
}
