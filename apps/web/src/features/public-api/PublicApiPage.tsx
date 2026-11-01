import type {
  ApiChange,
  ApiSymbol,
  PublicApiPackageDetail,
  PublicApiPackageSummary,
} from '@holtkeeper/api'
import { Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowLeft, FileText, Library, RefreshCw, Search } from 'lucide-react'
import { useDeferredValue, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import {
  usePublicApiDiff,
  usePublicApiPackage,
  usePublicApiPackages,
  usePublicApiRescan,
  usePublicApiSearch,
} from '../../api/queries.ts'
import { analysisPages } from '../../lib/analyses.ts'
import { formatDate, formatDateTime, formatRef, formatRelative, plural } from '../../lib/format.ts'
import {
  documentedShare,
  groupSymbols,
  symbolKinds,
  versionKey,
  versionLabel,
} from '../../lib/public-api.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  LoadMore,
  Markdown,
  Notice,
  Page,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  Select,
  StatCard,
  Table,
  Tabs,
  Td,
  Th,
  notify,
} from '../../ui/index.ts'
import { AnalysisRecords } from '../analyses/AnalysesPage.tsx'
import { BackfillReleasesButton } from '../analyses/BackfillReleases.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { useSession } from '../shell/session.ts'
import { ImpactTab, UsedByTab } from './UsagesTabs.tsx'

const page = analysisPages.find((p) => p.kind === 'api-surface') ?? analysisPages[0]

interface PublicApiSearch {
  package?: string
  version?: string
  repo?: string
  tab?: string
}

/** Public API of every package per version and symbol search. */
export function PublicApiPage() {
  const search: PublicApiSearch = useSearch({ strict: false })
  if (search.tab === 'mcp' && !search.package) return <Navigate to="/mcp-server" replace />
  if (search.package)
    return (
      <PackageView
        name={search.package}
        {...(search.version ? { version: search.version } : {})}
        {...(search.repo ? { repo: search.repo } : {})}
        {...(search.tab ? { tab: search.tab } : {})}
      />
    )
  return <CatalogView tab={search.tab ?? 'packages'} />
}

function CatalogView({ tab }: { tab: string }) {
  const navigate = useNavigate()
  const { can } = useSession()
  const rescan = usePublicApiRescan()
  return (
    <Page
      title="Public API"
      icon="api"
      description="What every package exports, per released version"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {can('analyses:run') ? (
            <Button
              variant="tertiary"
              isPending={rescan.isPending}
              onPress={() =>
                rescan.mutate(undefined, {
                  onError: (error) => notify.error('Not reread', messageOf(error)),
                })
              }
            >
              <RefreshCw className="size-3.5" />
              Reread records
            </Button>
          ) : null}
          <BackfillReleasesButton api />
          <RunJobButton analyzer="api-surface" label="Run now" variant="secondary" />
        </div>
      }
    >
      <Tabs
        aria-label="Public API views"
        selected={tab}
        onSelect={(next) => void navigate({ to: '/public-api', search: { tab: next } })}
        items={[
          { id: 'packages', label: 'Packages', content: <PackagesTab /> },
          { id: 'search', label: 'Search', content: <SearchTab /> },
          { id: 'records', label: 'Reports', content: <AnalysisRecords page={page} /> },
        ]}
      />
    </Page>
  )
}

function DocumentedBar({ documented, exports }: { documented: number; exports: number }) {
  const share = documentedShare(documented, exports)
  if (share === undefined) return <span className="text-muted">—</span>
  const color = share >= 80 ? 'var(--success)' : share >= 40 ? 'var(--warning)' : 'var(--danger)'
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-default">
        <span
          className="block h-full rounded-full"
          style={{ width: `${share}%`, background: color }}
        />
      </span>
      <span className="tabular w-9 text-right">{share}%</span>
    </span>
  )
}

function PackagesTab() {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const packages = usePublicApiPackages(deferred.trim() || undefined)

  if (packages.isPending) return <Placeholder className="h-96" />
  if (packages.isError) return <ErrorState error={packages.error} />
  const list = packages.data.packages
  const exports = list.reduce((sum, pkg) => sum + pkg.exports, 0)
  const documented = list.reduce((sum, pkg) => sum + pkg.documented, 0)
  const versions = list.reduce((sum, pkg) => sum + pkg.versions, 0)
  const repos = new Set(list.map((pkg) => repoKey(pkg.repo))).size

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Packages"
          value={list.length}
          hint={`in ${plural(repos, 'repository', 'repositories')}`}
          icon={<Library />}
        />
        <StatCard label="Exports" value={exports} hint="functions, classes, types, constants" />
        <StatCard
          label="Documented"
          value={documentedShare(documented, exports) ?? 0}
          hint="% of exports with a doc comment"
          accent="var(--success)"
        />
        <StatCard
          label="Versions on record"
          value={versions}
          hint="releases plus default branches"
        />
      </div>
      <Panel
        title="Packages"
        description={
          packages.data.indexedAt
            ? `Newest record of each package; all records reread ${formatRelative(packages.data.indexedAt)}.`
            : 'Newest record of each package.'
        }
        actions={
          <SearchInput
            aria-label="Filter packages"
            placeholder="Name, description or repository"
            value={query}
            onChange={setQuery}
            className="w-72"
          />
        }
      >
        {list.length ? (
          <Table label="Packages">
            <thead>
              <tr>
                <Th>Package</Th>
                <Th>Version</Th>
                <Th>Repository</Th>
                <Th align="right">Exports</Th>
                <Th>Documented</Th>
                <Th align="right">Versions</Th>
                <Th>Analyzed</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((pkg) => (
                <PackageRow key={`${repoKey(pkg.repo)} ${pkg.name}`} pkg={pkg} />
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={<Library />}
            title={query ? 'No package matches' : 'No package indexed yet'}
            description={
              query
                ? 'Try part of the name or the repository path.'
                : 'Run the api-surface analyzer on a repository, or analyze past releases to fill in the version history.'
            }
          />
        )}
      </Panel>
    </div>
  )
}

function PackageRow({ pkg }: { pkg: PublicApiPackageSummary }) {
  return (
    <tr className="hover:bg-default/40">
      <Td>
        <Link
          to="/public-api"
          search={{ package: pkg.name, repo: repoKey(pkg.repo) }}
          className="font-mono text-[13px] font-medium hover:underline"
        >
          {pkg.name}
        </Link>
        {pkg.private ? (
          <Chip className="ml-2" size="sm">
            private
          </Chip>
        ) : null}
        {pkg.removed ? (
          <span title={`Not on the default branch since ${formatDate(pkg.removed.at)}`}>
            <Chip className="ml-2" size="sm" tone="danger">
              removed
            </Chip>
          </span>
        ) : null}
        {pkg.description ? (
          <div className="mt-0.5 max-w-md truncate text-xs text-muted">{pkg.description}</div>
        ) : null}
      </Td>
      <Td className="tabular">{pkg.version ?? '—'}</Td>
      <Td>
        <span className="text-muted">{repoKey(pkg.repo)}</span>
        {pkg.dir !== '.' ? <span className="ml-1 text-xs text-muted">/{pkg.dir}</span> : null}
      </Td>
      <Td align="right" className="tabular">
        {pkg.exports}
      </Td>
      <Td>
        <DocumentedBar documented={pkg.documented} exports={pkg.exports} />
      </Td>
      <Td align="right" className="tabular">
        {pkg.versions}
      </Td>
      <Td className="whitespace-nowrap text-muted">
        {pkg.ref ? (
          <span className="mr-1 font-mono text-xs" title={pkg.ref}>
            {formatRef(pkg.ref)}
          </span>
        ) : null}
        {formatRelative(pkg.analyzedAt)}
      </Td>
    </tr>
  )
}

function Signature({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-border bg-default px-3 py-2 font-mono text-[12.5px] leading-relaxed">
      {code}
    </pre>
  )
}

function SymbolCard({ symbol, importFrom }: { symbol: ApiSymbol; importFrom: string }) {
  return (
    <div
      id={`symbol-${symbol.name}`}
      className="flex flex-col gap-2 border-b border-border py-4 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{symbol.name}</span>
        <Chip size="sm">{symbol.kind}</Chip>
        {symbol.deprecated !== undefined ? (
          <Chip tone="warning" size="sm">
            deprecated
          </Chip>
        ) : null}
        <span className="ml-auto font-mono text-xs text-muted">
          {symbol.file}:{symbol.line}
        </span>
      </div>
      {symbol.deprecated ? (
        <div className="text-sm text-warning">Deprecated: {symbol.deprecated}</div>
      ) : null}
      {symbol.doc ? <Markdown className="text-sm" text={symbol.doc} /> : null}
      <Signature code={symbol.signature} />
      {symbol.kind !== 'reexport' ? (
        <div className="font-mono text-xs text-muted">
          import {symbol.name === 'default' ? 'value' : `{ ${symbol.name} }`} from '{importFrom}'
        </div>
      ) : null}
    </div>
  )
}

const symbolPage = 150

const packageTabs = ['api', 'changes', 'used-by', 'impact']

function PackageView({
  name,
  version,
  repo,
  tab: requested,
}: {
  name: string
  version?: string
  repo?: string
  tab?: string
}) {
  const navigate = useNavigate()
  const detail = usePublicApiPackage({
    name,
    ...(version ? { version } : {}),
    ...(repo ? { repo } : {}),
  })
  const tab = requested && packageTabs.includes(requested) ? requested : 'api'

  const go = (next: { version?: string; repo?: string; tab?: string }, replace = false) => {
    const nextTab = next.tab ?? tab
    void navigate({
      to: '/public-api',
      search: {
        package: name,
        ...(next.version ? { version: next.version } : {}),
        ...((next.repo ?? repo) ? { repo: next.repo ?? repo } : {}),
        ...(nextTab !== 'api' ? { tab: nextTab } : {}),
      },
      replace,
    })
  }

  const data = detail.data
  return (
    <Page
      title={<span className="font-mono">{name}</span>}
      eyebrow={
        <Link
          to="/public-api"
          search={{}}
          className="inline-flex items-center gap-1 hover:underline"
        >
          <ArrowLeft className="size-3.5" />
          Public API
        </Link>
      }
      icon="api"
      description={data?.package.description ?? (data ? repoKey(data.repo) : undefined)}
      actions={
        data ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Version"
              className="w-56"
              value={versionKey(
                data.versions.find((v) => v.analysisId === data.analysisId) ?? data.versions[0]!,
              )}
              onChange={(value) => go({ version: value, repo: repoKey(data.repo) })}
              options={data.versions.map((v) => ({
                id: versionKey(v),
                label: versionLabel(v),
                text: versionLabel(v),
              }))}
            />
            <a
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm hover:bg-default"
              href={api.publicApiMarkdownUrl({
                name,
                version: data.versions.find((v) => v.analysisId === data.analysisId)?.head
                  ? 'head'
                  : (data.package.version ?? data.ref ?? 'latest'),
                repo: repoKey(data.repo),
              })}
              target="_blank"
              rel="noreferrer"
            >
              <FileText className="size-3.5" />
              Markdown
            </a>
          </div>
        ) : null
      }
    >
      {detail.isPending ? (
        <Placeholder className="h-96" />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : data ? (
        <>
          {data.removed ? (
            <Notice tone="danger" title="Removed from the repository">
              {repoKey(data.repo)} has not had this package on its default branch since{' '}
              {formatDate(data.removed.at)}; avoid it in new code.
              {data.removed.renamedTo ? ` Probably renamed to ${data.removed.renamedTo}.` : ''}
              {data.removed.movedTo
                ? ` Still in ${data.removed.movedTo.map((other) => repoKey(other)).join(', ')}.`
                : ''}
            </Notice>
          ) : null}
          <PackageFacts data={data} onRepo={(next) => go({ repo: next })} />
          <Tabs
            aria-label="Package views"
            selected={tab}
            onSelect={(next) => go({ ...(version ? { version } : {}), tab: next }, true)}
            items={[
              { id: 'api', label: 'API', content: <ApiTab data={data} /> },
              {
                id: 'changes',
                label: 'Changes',
                content: <ChangesTab data={data} />,
              },
              { id: 'used-by', label: 'Used by', content: <UsedByTab data={data} /> },
              { id: 'impact', label: 'Upgrade impact', content: <ImpactTab data={data} /> },
            ]}
          />
        </>
      ) : null}
    </Page>
  )
}

function PackageFacts({
  data,
  onRepo,
}: {
  data: PublicApiPackageDetail
  onRepo: (repo: string) => void
}) {
  const exports = data.package.entries.reduce(
    (sum, entry) => sum + entry.symbols.filter((s) => s.kind !== 'reexport').length,
    0,
  )
  const documented = data.package.entries.reduce(
    (sum, entry) => sum + entry.symbols.filter((s) => s.kind !== 'reexport' && s.doc).length,
    0,
  )
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted">
      <span>
        <span className="text-foreground">{data.package.version ?? 'no version'}</span>
        {data.ref ? (
          <span className="ml-1 font-mono text-xs" title={data.ref}>
            ({formatRef(data.ref)})
          </span>
        ) : (
          ' · default branch'
        )}
      </span>
      <span>
        <Link to="/repos/view" search={{ repo: repoKey(data.repo) }} className="hover:underline">
          {repoKey(data.repo)}
        </Link>
        {data.package.dir !== '.' ? (
          <span className="ml-1 font-mono text-xs">/{data.package.dir}</span>
        ) : null}
      </span>
      <span>{plural(exports, 'export')}</span>
      <span className="inline-flex items-center gap-2">
        documented <DocumentedBar documented={documented} exports={exports} />
      </span>
      <span>analyzed {formatDateTime(data.analyzedAt)}</span>
      {data.alsoIn.length ? (
        <span className="inline-flex items-center gap-2">
          also in
          {data.alsoIn.map((other) => (
            <Button
              key={repoKey(other)}
              size="sm"
              variant="ghost"
              onPress={() => onRepo(repoKey(other))}
            >
              {repoKey(other)}
            </Button>
          ))}
        </span>
      ) : null}
    </div>
  )
}

function ApiTab({ data }: { data: PublicApiPackageDetail }) {
  const entries = data.package.entries
  const [subpath, setSubpath] = useState(entries[0]?.subpath ?? '.')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(symbolPage)
  const entry = entries.find((item) => item.subpath === subpath) ?? entries[0]
  if (!entry) return <EmptyState title="No entry point" />
  const importFrom =
    entry.subpath === '.'
      ? data.package.name
      : `${data.package.name}/${entry.subpath.replace(/^\.\//, '')}`
  const groups = groupSymbols(entry.symbols, query)
  let shown = 0
  return (
    <Panel
      title={<span className="font-mono">{importFrom}</span>}
      description={`${plural(entry.symbols.length, 'export')}${entry.file ? ` from ${entry.file}` : ''}${entry.truncated ? `, ${entry.truncated} more not recorded` : ''}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {entries.length > 1 ? (
            <Select
              aria-label="Entry point"
              className="w-56"
              value={entry.subpath}
              onChange={(value) => {
                setSubpath(value)
                setLimit(symbolPage)
              }}
              options={entries.map((item) => ({
                id: item.subpath,
                label: `${item.subpath} (${item.symbols.length})`,
                text: item.subpath,
              }))}
            />
          ) : null}
          <SearchInput
            aria-label="Filter exports"
            placeholder="Name or doc text"
            value={query}
            onChange={setQuery}
            className="w-64"
          />
        </div>
      }
    >
      {groups.length ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap gap-2">
            {groups.map((group) => (
              <a
                key={group.kind}
                href={`#kind-${group.kind}`}
                className="text-sm text-muted hover:text-foreground"
              >
                {group.label} <span className="tabular">{group.symbols.length}</span>
              </a>
            ))}
          </div>
          {groups.map((group) => {
            const visible = group.symbols.slice(0, Math.max(0, limit - shown))
            shown += visible.length
            if (!visible.length) return null
            return (
              <section key={group.kind} id={`kind-${group.kind}`}>
                <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                  {group.label}
                </h2>
                {visible.map((symbol) => (
                  <SymbolCard key={symbol.name} symbol={symbol} importFrom={importFrom} />
                ))}
              </section>
            )
          })}
          {groups.reduce((sum, group) => sum + group.symbols.length, 0) > limit ? (
            <LoadMore onLoad={() => setLimit(limit + symbolPage)}>Show more</LoadMore>
          ) : null}
        </div>
      ) : (
        <EmptyState
          icon={<Search />}
          title="Nothing matches"
          description="Try another part of the name."
        />
      )}
    </Panel>
  )
}

const changeTone = {
  removed: 'danger',
  changed: 'warning',
  deprecated: 'warning',
  added: 'success',
} as const

function ChangeRow({ change, pkg }: { change: ApiChange; pkg: string }) {
  const from = change.subpath === '.' ? pkg : `${pkg}/${change.subpath.replace(/^\.\//, '')}`
  return (
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={changeTone[change.change]} size="sm">
          {change.change}
        </Chip>
        <span className="font-mono text-sm font-medium">{change.name}</span>
        <Chip size="sm">{change.kind}</Chip>
        <span className="font-mono text-xs text-muted">{from}</span>
      </div>
      {change.change === 'changed' && change.before && change.after ? (
        <div className="grid gap-2 lg:grid-cols-2">
          <div>
            <div className="mb-1 text-xs text-muted">Before</div>
            <Signature code={change.before} />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">After</div>
            <Signature code={change.after} />
          </div>
        </div>
      ) : change.after || change.before ? (
        <Signature code={change.after ?? change.before ?? ''} />
      ) : null}
    </div>
  )
}

function ChangesTab({ data }: { data: PublicApiPackageDetail }) {
  const current = data.versions.find((v) => v.analysisId === data.analysisId)
  const older = data.versions.filter(
    (v) => !v.head && v.analysisId !== data.analysisId && v.analyzedAt <= data.analyzedAt,
  )
  const [from, setFrom] = useState<string | undefined>(undefined)
  const fromKey = from ?? (older[0] ? versionKey(older[0]) : undefined)
  const diff = usePublicApiDiff(
    {
      name: data.package.name,
      to: current ? versionKey(current) : 'latest',
      repo: repoKey(data.repo),
      ...(fromKey ? { from: fromKey } : {}),
    },
    fromKey !== undefined,
  )
  const [kind, setKind] = useState<'all' | ApiChange['change']>('all')

  if (!fromKey)
    return (
      <EmptyState
        title="No earlier version on record"
        description="Analyze past releases with the public API snapshot to compare versions."
        action={<BackfillReleasesButton repo={data.repo} api />}
      />
    )
  const result = diff.data
  const changes =
    result?.diff.changes.filter((change) => kind === 'all' || change.change === kind) ?? []
  return (
    <Panel
      title={
        result
          ? `${result.from.version} → ${current ? versionLabel(current) : result.to.version}`
          : 'Changes'
      }
      description={
        result
          ? `${result.diff.removed} removed, ${result.diff.changed} changed, ${result.diff.deprecated} deprecated, ${result.diff.added} added; calls for a ${result.diff.required} release${result.diff.bumped ? `, the version got a ${result.diff.bumped} bump` : ''}.`
          : undefined
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Compare with"
            className="w-56"
            value={fromKey}
            onChange={setFrom}
            options={older.map((v) => ({
              id: versionKey(v),
              label: `from ${versionLabel(v)}`,
              text: versionLabel(v),
            }))}
          />
          <Segmented
            aria-label="Change kind"
            value={kind}
            onChange={setKind}
            options={[
              { id: 'all', label: 'All' },
              { id: 'removed', label: 'Removed' },
              { id: 'changed', label: 'Changed' },
              { id: 'added', label: 'Added' },
            ]}
          />
        </div>
      }
    >
      {diff.isPending ? (
        <Placeholder className="h-48" />
      ) : diff.isError ? (
        <ErrorState error={diff.error} />
      ) : result ? (
        <div className="flex flex-col gap-3">
          {result.diff.semverWarning ? (
            <Notice tone="danger" title="Semver">
              {result.diff.semverWarning}.
            </Notice>
          ) : null}
          {changes.length ? (
            <div>
              {changes.map((change) => (
                <ChangeRow
                  key={`${change.change} ${change.subpath} ${change.name}`}
                  change={change}
                  pkg={data.package.name}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No changes"
              description="No export of this kind changed between these versions."
            />
          )}
        </div>
      ) : null}
    </Panel>
  )
}

function SearchTab() {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('*')
  const deferred = useDeferredValue(query)
  const results = usePublicApiSearch({ q: deferred, ...(kind !== '*' ? { kind } : {}) })
  return (
    <Panel
      title="Find an export"
      description="Exact names first, then prefixes, parts of names and words in doc comments; newest version of each package."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Kind"
            className="w-40"
            value={kind}
            onChange={setKind}
            options={[
              { id: '*', label: 'Any kind' },
              ...symbolKinds.map((k) => ({ id: k.kind, label: k.label })),
            ]}
          />
          <SearchInput
            aria-label="Search exports"
            placeholder="e.g. createClient"
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
          title="Search the catalog"
          description="Type a function, class or type name, or words from its docs."
        />
      ) : results.isPending ? (
        <Placeholder className="h-48" />
      ) : results.isError ? (
        <ErrorState error={results.error} />
      ) : results.data.hits.length ? (
        <div>
          {results.data.hits.map((hit) => (
            <div
              key={`${repoKey(hit.repo)} ${hit.importPath} ${hit.symbol.name}`}
              className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/public-api"
                  search={{ package: hit.package, repo: repoKey(hit.repo) }}
                  hash={`symbol-${hit.symbol.name}`}
                  className="font-mono text-sm font-semibold hover:underline"
                >
                  {hit.symbol.name}
                </Link>
                <Chip size="sm">{hit.symbol.kind}</Chip>
                {hit.symbol.deprecated !== undefined ? (
                  <Chip tone="warning" size="sm">
                    deprecated
                  </Chip>
                ) : null}
                <span className="font-mono text-xs text-muted">
                  {hit.importPath}
                  {hit.version ? `@${hit.version}` : ''}
                </span>
              </div>
              {hit.symbol.doc ? (
                <div className="text-sm text-muted">{hit.symbol.doc.split('\n\n')[0]}</div>
              ) : null}
              <Signature
                code={
                  hit.symbol.signature.length > 800
                    ? `${hit.symbol.signature.slice(0, 800)}\n…`
                    : hit.symbol.signature
                }
              />
            </div>
          ))}
          {results.data.more ? (
            <p className="pt-3 text-sm text-muted">
              …and {results.data.more} more; narrow the query or the kind.
            </p>
          ) : null}
        </div>
      ) : (
        <EmptyState
          title="Nothing exported matches"
          description="Try a shorter part of the name."
        />
      )}
    </Panel>
  )
}
