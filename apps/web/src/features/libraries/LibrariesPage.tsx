import type { LibraryIndexRun, LibrarySummary } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { AlertTriangle, Bot, LibraryBig, RefreshCw } from 'lucide-react'
import { useDeferredValue, useEffect, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useLibraries, useReindexLibraries } from '../../api/queries.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import {
  type LibraryEcosystem,
  libraryEcosystems,
  libraryListQuery,
  parseEcosystem,
  runSummary,
  sourceLabel,
} from '../../lib/libraries.ts'
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Notice,
  Page,
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
import { useSession } from '../shell/session.ts'

const shownVersions = 4

/** The MCP tools agents use to read indexed library docs. */
export const libraryTools = [
  'library_versions',
  'search_library_docs',
  'read_library_doc',
  'library_changes',
  'search_library_issues',
  'library_source',
] as const

/** Where agents get this from: the MCP tools and a link to the endpoint setup. */
export function AgentToolsNote() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm shadow-surface">
      <Bot className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <p className="text-muted">
        Agents read these docs through the MCP tools{' '}
        {libraryTools.map((tool, index) => (
          <span key={tool}>
            <code className="rounded bg-default px-1 py-0.5 font-mono text-xs text-foreground">
              {tool}
            </code>
            {index < libraryTools.length - 1 ? ', ' : ''}
          </span>
        ))}
        , answering for the version the asking repository uses.{' '}
        <Link to="/public-api" search={{ tab: 'mcp' }} className="text-foreground hover:underline">
          Connect an agent
        </Link>
      </p>
    </div>
  )
}

/** Third-party libraries indexed for agents: what is indexed, failures and the last run. */
export function LibrariesPage() {
  const search: { q?: string; ecosystem?: string } = useSearch({ strict: false })
  const navigate = useNavigate()
  const { can } = useSession()
  const [query, setQuery] = useState(search.q ?? '')
  const deferred = useDeferredValue(query)
  const ecosystem = parseEcosystem(search.ecosystem) ?? 'all'
  const filter = libraryListQuery({ q: deferred, ecosystem })
  const libraries = useLibraries(filter)
  const reindex = useReindexLibraries()

  useEffect(() => {
    const q = deferred.trim()
    if (q !== (search.q ?? ''))
      void navigate({
        to: '/libraries',
        search: {
          ...(q ? { q } : {}),
          ...(search.ecosystem ? { ecosystem: search.ecosystem } : {}),
        },
        replace: true,
      })
  }, [deferred, navigate, search.q, search.ecosystem])

  const setEcosystem = (next: LibraryEcosystem | 'all') =>
    void navigate({
      to: '/libraries',
      search: {
        ...(search.q ? { q: search.q } : {}),
        ...(next !== 'all' ? { ecosystem: next } : {}),
      },
      replace: true,
    })

  const data = libraries.data
  return (
    <Page
      title="Libraries"
      icon="libraries"
      description="Version-exact docs of the third-party libraries the fleet depends on, indexed for agents"
      actions={
        can('analyses:run') && data?.enabled ? (
          <Button
            variant="secondary"
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
        ) : undefined
      }
    >
      {libraries.isPending ? (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <Placeholder key={index} className="h-24" />
            ))}
          </div>
          <Placeholder className="h-96" />
        </div>
      ) : libraries.isError ? (
        <ErrorState error={libraries.error} />
      ) : !data?.enabled ? (
        <EmptyState
          icon={<LibraryBig />}
          title="Library indexing is off"
          description="Turn on the libraries setting (enabled: true) and run the server with a store that keeps libraries. The indexer then fetches docs, release notes and APIs of every library the fleet resolves, plus the versions an upgrade would land on; exclude, include, maxVersions and sources narrow it."
        />
      ) : (
        <>
          <Totals libraries={data.libraries} />
          <AgentToolsNote />
          {data.lastRun ? <LastRun run={data.lastRun} /> : null}
          <Panel
            title="Indexed libraries"
            description={
              filter.q || filter.ecosystem
                ? `${plural(data.libraries.length, 'library', 'libraries')} match`
                : 'Libraries used by repositories you can read'
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
                    : 'The indexer runs after usages and fleet records change and once a week; repositories need a usages record first.'
                }
              />
            )}
          </Panel>
        </>
      )}
    </Page>
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
          <Link
            to="/libraries/view"
            search={{ ecosystem: library.ecosystem, name: library.name }}
            className="font-mono text-[13px] font-medium hover:underline"
          >
            {library.name}
          </Link>
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
