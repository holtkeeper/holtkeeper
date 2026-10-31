import type { LibraryDetail } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowLeft, ArrowUpRight, FileText, LibraryBig, Search } from 'lucide-react'
import { useDeferredValue, useState } from 'react'

import { useLibrary, useLibrarySearch } from '../../api/queries.ts'
import { formatDate, formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import {
  type LibraryEcosystem,
  type LibraryHit,
  type LibrarySourceKind,
  type LibrarySourceState,
  type LibraryVersion,
  excerpt,
  formatRoles,
  groupDocuments,
  headingPath,
  httpUrl,
  librarySearchQuery,
  parseEcosystem,
  sortedSources,
  sourceLabel,
  toneOfRole,
  toneOfStatus,
} from '../../lib/libraries.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  SearchInput,
  Select,
  Table,
  Td,
  Th,
  Tooltip,
} from '../../ui/index.ts'
import { AgentToolsNote } from './LibrariesPage.tsx'

const shownRepos = 3
const searchLimit = 30

interface LibrarySearch {
  ecosystem?: string
  name?: string
  version?: string
}

/** One indexed library: its version matrix, documents and a docs search scoped to it. */
export function LibraryPage() {
  const search: LibrarySearch = useSearch({ strict: false })
  const ecosystem = parseEcosystem(search.ecosystem)
  if (!ecosystem || !search.name)
    return (
      <Page title="Library" icon="knowledge" eyebrow={<BackLink />}>
        <EmptyState
          icon={<LibraryBig />}
          title="No library picked"
          description="Open a library from the list."
        />
      </Page>
    )
  return (
    <LibraryView
      ecosystem={ecosystem}
      name={search.name}
      {...(search.version ? { version: search.version } : {})}
    />
  )
}

function BackLink() {
  return (
    <Link to="/libraries" search={{}} className="inline-flex items-center gap-1 hover:underline">
      <ArrowLeft className="size-3.5" />
      Libraries
    </Link>
  )
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-foreground hover:underline"
    >
      {children}
      <ArrowUpRight className="size-3.5" aria-hidden />
    </a>
  )
}

function LibraryView({
  ecosystem,
  name,
  version,
}: {
  ecosystem: LibraryEcosystem
  name: string
  version?: string
}) {
  const navigate = useNavigate()
  const detail = useLibrary(ecosystem, name)
  const setVersion = (next: string | undefined) =>
    void navigate({
      to: '/libraries/view',
      search: { ecosystem, name, ...(next ? { version: next } : {}) },
      replace: true,
    })
  return (
    <Page
      title={<span className="font-mono">{name}</span>}
      eyebrow={<BackLink />}
      icon="knowledge"
      description={detail.data?.library.description}
    >
      {detail.isPending ? (
        <div className="flex flex-col gap-4">
          <Placeholder className="h-10" />
          <Placeholder className="h-64" />
          <Placeholder className="h-64" />
        </div>
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : (
        <>
          <Facts data={detail.data} />
          <VersionsPanel versions={detail.data.versions} />
          <DocumentsPanel data={detail.data} />
          <DocsSearch
            ecosystem={ecosystem}
            name={name}
            versions={detail.data.versions.map((v) => v.version)}
            {...(version ? { version } : {})}
            onVersion={setVersion}
          />
          <AgentToolsNote />
        </>
      )}
    </Page>
  )
}

function SourceChips({
  sources,
}: {
  sources: Partial<Record<LibrarySourceKind, LibrarySourceState>>
}) {
  const list = sortedSources(sources)
  if (!list.length) return <span className="text-muted">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((source) => (
        <Tooltip
          key={source.kind}
          content={
            <span className="block max-w-sm">
              {source.label}: {source.state.status} · {formatDateTime(source.state.at)}
              {source.state.message ? (
                <span className="mt-1 block break-words">{source.state.message}</span>
              ) : null}
            </span>
          }
        >
          <span tabIndex={0} className="inline-flex">
            <Chip tone={toneOfStatus(source.state.status)}>
              {source.label.toLowerCase()}
              {source.state.status === 'ok' ? '' : ` ${source.state.status}`}
            </Chip>
          </span>
        </Tooltip>
      ))}
    </div>
  )
}

function Facts({ data }: { data: LibraryDetail }) {
  const { library } = data
  const repository = httpUrl(library.repository?.url)
  const homepage = httpUrl(library.homepage)
  return (
    <div className="flex flex-col gap-3 text-sm text-muted">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Chip>{library.ecosystem}</Chip>
        <span>
          latest <span className="tabular text-foreground">{library.latest ?? '—'}</span>
        </span>
        {repository && library.repository ? (
          <span className="inline-flex items-center gap-1.5">
            repository
            <ExternalLink href={repository}>
              {`${library.repository.host}/${library.repository.path}${library.repository.directory ? `/${library.repository.directory}` : ''}`}
            </ExternalLink>
          </span>
        ) : null}
        {homepage && homepage !== repository ? (
          <span className="inline-flex items-center gap-1.5">
            homepage
            <ExternalLink href={homepage}>{new URL(homepage).host}</ExternalLink>
          </span>
        ) : null}
        <span>
          {plural(data.versions.length, 'indexed version')} · updated{' '}
          {formatRelative(library.updatedAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>Library sources</span>
        <SourceChips sources={library.sources} />
      </div>
    </div>
  )
}

function UsedBy({ repos }: { repos: string[] }) {
  if (!repos.length) return <span className="text-muted">—</span>
  const rest = repos.length - shownRepos
  return (
    <div className="flex flex-col gap-0.5">
      {repos.slice(0, shownRepos).map((repo) => (
        <Link
          key={repo}
          to="/repos/view"
          search={{ repo }}
          className="truncate text-[13px] hover:underline"
        >
          {repo}
        </Link>
      ))}
      {rest > 0 ? (
        <Tooltip content={repos.slice(shownRepos).join(', ')}>
          <span tabIndex={0} className="text-xs text-muted">
            +{rest} more
          </span>
        </Tooltip>
      ) : null}
    </div>
  )
}

function VersionsPanel({ versions }: { versions: LibraryVersion[] }) {
  return (
    <Panel
      title="Versions"
      description="Versions in use and the ones an upgrade would land on, highest first"
    >
      {versions.length ? (
        <Table label="Indexed versions">
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>Roles</Th>
              <Th>Published</Th>
              <Th>Used by</Th>
              <Th>Sources</Th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.version} className="align-top hover:bg-default/40">
                <Td className="max-w-[18rem]">
                  <div className="font-mono text-[13px] font-medium">{version.version}</div>
                  {version.tag ? (
                    <div className="truncate font-mono text-xs text-muted" title={version.tag}>
                      {version.tag}
                    </div>
                  ) : null}
                  {version.deprecated !== undefined ? (
                    <div className="mt-1 text-xs text-warning">
                      Deprecated{version.deprecated ? `: ${version.deprecated}` : ''}
                    </div>
                  ) : null}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {version.roles.length ? (
                      formatRoles(version.roles).map((role) => (
                        <Tooltip key={role.id} content={role.description}>
                          <span tabIndex={0} className="inline-flex">
                            <Chip tone={toneOfRole(role.id)}>{role.label}</Chip>
                          </span>
                        </Tooltip>
                      ))
                    ) : (
                      <Tooltip
                        content={
                          version.leftAt
                            ? `Left the matrix ${formatDateTime(version.leftAt)}; removed after the grace period`
                            : 'No longer in the matrix'
                        }
                      >
                        <span tabIndex={0} className="inline-flex">
                          <Chip variant="tertiary">leaving</Chip>
                        </span>
                      </Tooltip>
                    )}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-muted">
                  {version.publishedAt ? formatDate(version.publishedAt) : '—'}
                </Td>
                <Td className="max-w-[16rem]">
                  <UsedBy repos={version.usedBy} />
                </Td>
                <Td>
                  <SourceChips sources={version.sources} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState title="No version indexed yet" />
      )}
    </Panel>
  )
}

function DocumentsPanel({ data }: { data: LibraryDetail }) {
  const groups = groupDocuments(data.documents)
  return (
    <Panel
      title="Documents"
      description={
        data.versions[0]
          ? `What the newest indexed version, ${data.versions[0].version}, ships`
          : undefined
      }
    >
      {groups.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {groups.map((group) => (
            <section key={group.source} className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-medium">
                {group.label}{' '}
                <span className="font-normal text-muted">
                  · {plural(group.documents.length, 'document')}
                </span>
              </h3>
              <ul className="flex max-h-72 flex-col gap-1 overflow-auto">
                {group.documents.map((doc) => (
                  <li
                    key={doc.path}
                    className="flex items-baseline justify-between gap-3 text-[13px]"
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />
                      <span className="truncate font-mono" title={doc.path}>
                        {doc.path}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-xs text-muted">
                      {plural(doc.chunks, 'section')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<FileText />}
          title="No documents indexed"
          description="The package archive, repository and releases had no Markdown to index, or their sources failed."
        />
      )}
    </Panel>
  )
}

function DocsSearch({
  ecosystem,
  name,
  versions,
  version,
  onVersion,
}: {
  ecosystem: LibraryEcosystem
  name: string
  versions: string[]
  version?: string
  onVersion: (version: string | undefined) => void
}) {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const results = useLibrarySearch(
    librarySearchQuery({
      q: deferred,
      ecosystem,
      name,
      ...(version ? { version } : {}),
      limit: searchLimit,
    }),
  )
  return (
    <Panel
      title="Search the docs"
      description="Full text over this library's sections, the way agents search them"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Version"
            className="w-44"
            value={version ?? '*'}
            onChange={(next) => onVersion(next === '*' ? undefined : next)}
            options={[
              { id: '*', label: 'Any version' },
              ...versions.map((v) => ({ id: v, label: v })),
            ]}
          />
          <SearchInput
            aria-label="Search library docs"
            placeholder="API name, error message, topic"
            value={query}
            onChange={setQuery}
            className="w-72"
          />
        </div>
      }
    >
      {!deferred.trim() ? (
        <EmptyState
          icon={<Search />}
          title="Search this library"
          description="Words match anywhere; quote a phrase to match it exactly."
        />
      ) : results.isPending ? (
        <Placeholder className="h-48" />
      ) : results.isError ? (
        <ErrorState error={results.error} />
      ) : results.data.hits.length ? (
        <div>
          {results.data.hits.map((hit) => (
            <SearchHit key={hit.chunk.id} hit={hit} />
          ))}
          {results.data.hits.length >= searchLimit ? (
            <p className="pt-3 text-sm text-muted">
              Showing the best {searchLimit}; narrow the query or pick a version.
            </p>
          ) : null}
        </div>
      ) : (
        <EmptyState title="No section matches" description="Try fewer or other words." />
      )}
    </Panel>
  )
}

function SearchHit({ hit }: { hit: LibraryHit }) {
  const { chunk } = hit
  const url = httpUrl(chunk.url)
  const title = chunk.headings.length ? headingPath(chunk.headings) : chunk.path
  return (
    <div className="flex flex-col gap-1.5 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-sm font-semibold hover:underline"
          >
            {title}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
        ) : (
          <span className="text-sm font-semibold">{title}</span>
        )}
        <Chip>{sourceLabel(chunk.source).toLowerCase()}</Chip>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="font-mono">{chunk.path}</span>
        <span>·</span>
        <span>
          {chunk.versions.length > 4
            ? `${chunk.versions.slice(0, 4).join(', ')} +${chunk.versions.length - 4}`
            : chunk.versions.join(', ')}
        </span>
      </div>
      <p className="text-sm text-muted">{excerpt(chunk.text)}</p>
    </div>
  )
}
