import type {
  ApiChange,
  ApiSymbol,
  McpUsageOverview,
  PublicApiPackageDetail,
  PublicApiPackageSummary,
} from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  ArrowLeft,
  Bot,
  FileText,
  KeyRound,
  Library,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { useDeferredValue, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { messageOf } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import {
  useCreateMcpToken,
  useMcpTokens,
  useMcpUsage,
  usePublicApiDiff,
  usePublicApiPackage,
  usePublicApiPackages,
  usePublicApiRescan,
  usePublicApiSearch,
  useRevokeMcpToken,
} from '../../api/queries.ts'
import { analysisPages } from '../../lib/analyses.ts'
import { formatDate, formatDateTime, formatRef, formatRelative, plural } from '../../lib/format.ts'
import {
  documentedShare,
  groupSymbols,
  mcpSetup,
  symbolKinds,
  tokenLifetimes,
  versionKey,
  versionLabel,
} from '../../lib/public-api.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  CopyField,
  Dialog,
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
  TextField,
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

/** Public API of every package per version, symbol search, and the MCP endpoint for agents. */
export function PublicApiPage() {
  const search: PublicApiSearch = useSearch({ strict: false })
  if (search.package)
    return (
      <PackageView
        name={search.package}
        {...(search.version ? { version: search.version } : {})}
        {...(search.repo ? { repo: search.repo } : {})}
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
      description="What every package exports, per released version, for people and for agents over MCP"
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
          { id: 'mcp', label: 'MCP for agents', content: <McpTab /> },
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

function PackageView({ name, version, repo }: { name: string; version?: string; repo?: string }) {
  const navigate = useNavigate()
  const detail = usePublicApiPackage({
    name,
    ...(version ? { version } : {}),
    ...(repo ? { repo } : {}),
  })
  const [tab, setTab] = useState('api')

  const go = (next: { version?: string; repo?: string }) =>
    void navigate({
      to: '/public-api',
      search: {
        package: name,
        ...(next.version ? { version: next.version } : {}),
        ...((next.repo ?? repo) ? { repo: next.repo ?? repo } : {}),
      },
    })

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
          <PackageFacts data={data} onRepo={(next) => go({ repo: next })} />
          <Tabs
            aria-label="Package views"
            selected={tab}
            onSelect={setTab}
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

const usageRanges = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
] as const

function McpTab() {
  const [range, setRange] = useState<(typeof usageRanges)[number]['id']>('30')
  const usage = useMcpUsage(Number(range))
  const endpoint = usage.data?.endpoint ?? `${window.location.origin}/mcp`
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <ConnectPanel endpoint={endpoint} />
        <TokensPanel endpoint={endpoint} />
      </div>
      <Panel
        title="Usage"
        description="Tool calls agents made through the MCP endpoint."
        actions={
          <Segmented aria-label="Range" value={range} onChange={setRange} options={usageRanges} />
        }
      >
        {usage.isPending ? (
          <Placeholder className="h-72" />
        ) : usage.isError ? (
          <ErrorState error={usage.error} />
        ) : (
          <UsageView usage={usage.data} />
        )}
      </Panel>
    </div>
  )
}

function ConnectPanel({ endpoint }: { endpoint: string }) {
  const setup = mcpSetup(endpoint)
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Bot className="size-4" />
          Connect an agent
        </span>
      }
      description="Streamable HTTP, read-only tools: list_packages, get_package_api, search_symbols, get_symbol, list_versions, diff_versions; for third-party libraries (see Libraries) library_versions, search_library_docs, read_library_doc, library_changes, search_library_issues, library_source."
    >
      <div className="flex flex-col gap-3 text-sm">
        <CopyField label="MCP endpoint" value={endpoint} />
        <div>
          <div className="mb-1 text-muted">Claude Code</div>
          <CopyField label="Claude Code command" value={setup.claudeCode} />
        </div>
        <div>
          <div className="mb-1 text-muted">Other clients (.mcp.json, Cursor, …)</div>
          <Signature code={setup.json} />
        </div>
        <p className="text-xs text-muted">
          Replace &lt;token&gt; with a token from the next panel. Tokens only read the catalog,
          within the repositories you can read.
        </p>
      </div>
    </Panel>
  )
}

function TokensPanel({ endpoint }: { endpoint: string }) {
  const tokens = useMcpTokens()
  const create = useCreateMcpToken()
  const revoke = useRevokeMcpToken()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [lifetime, setLifetime] = useState<(typeof tokenLifetimes)[number]['id']>('90')
  const [secret, setSecret] = useState<string | undefined>(undefined)
  const [revoking, setRevoking] = useState<string | undefined>(undefined)

  const close = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setSecret(undefined)
      setName('')
    }
  }
  const submit = () =>
    create.mutate(
      { name: name.trim() || 'MCP client', expiresInDays: Number(lifetime) },
      {
        onSuccess: (result) => setSecret(result.secret),
        onError: (error) => notify.error('Not created', messageOf(error)),
      },
    )

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <KeyRound className="size-4" />
          Your tokens
        </span>
      }
      description="Personal access tokens for the MCP endpoint and the catalog API."
      actions={
        tokens.data?.available ? (
          <Button size="sm" variant="secondary" onPress={() => setOpen(true)}>
            <Plus className="size-3.5" />
            New token
          </Button>
        ) : null
      }
    >
      {tokens.isPending ? (
        <Placeholder className="h-32" />
      ) : tokens.isError ? (
        <ErrorState error={tokens.error} />
      ) : !tokens.data.available ? (
        <Notice title="Tokens are unavailable">
          The store keeps no key-value state; signed-in requests still reach the endpoint.
        </Notice>
      ) : tokens.data.tokens.length ? (
        <Table label="MCP tokens">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Token</Th>
              <Th>Expires</Th>
              <Th>Last used</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {tokens.data.tokens.map((token) => (
              <tr key={token.id}>
                <Td>{token.name}</Td>
                <Td className="font-mono text-xs text-muted">{token.prefix}…</Td>
                <Td className="text-muted">
                  {token.expiresAt ? formatDate(token.expiresAt) : 'never'}
                </Td>
                <Td className="text-muted">
                  {token.lastUsedAt ? formatRelative(token.lastUsedAt) : 'never'}
                </Td>
                <Td align="right">
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={`Revoke ${token.name}`}
                    onPress={() => setRevoking(token.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState
          icon={<KeyRound />}
          title="No tokens yet"
          description="Create one for each machine or agent you connect."
        />
      )}
      <Dialog
        isOpen={open}
        onOpenChange={close}
        title={secret ? 'Token created' : 'New MCP token'}
        description={
          secret ? 'Copy it now; it is not shown again.' : 'Read-only access to the catalog as you.'
        }
        footer={
          secret ? (
            <Button variant="primary" onPress={() => close(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="tertiary" onPress={() => close(false)}>
                Cancel
              </Button>
              <Button variant="primary" onPress={submit} isPending={create.isPending}>
                Create
              </Button>
            </>
          )
        }
      >
        {secret ? (
          <div className="flex flex-col gap-3">
            <CopyField label="Token" value={secret} />
            <div className="text-sm text-muted">Claude Code</div>
            <CopyField label="Claude Code command" value={mcpSetup(endpoint, secret).claudeCode} />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <TextField
              label="Name"
              placeholder="Laptop, CI agent, …"
              value={name}
              onChange={setName}
              autoFocus
            />
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">Expires after</span>
              <Segmented
                aria-label="Expires after"
                value={lifetime}
                onChange={setLifetime}
                options={tokenLifetimes}
              />
            </div>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        isOpen={revoking !== undefined}
        onOpenChange={(next) => {
          if (!next) setRevoking(undefined)
        }}
        title="Revoke this token?"
        confirmLabel="Revoke"
        isPending={revoke.isPending}
        onConfirm={() => {
          if (!revoking) return
          revoke.mutate(revoking, {
            onSuccess: () => setRevoking(undefined),
            onError: (error) => notify.error('Not revoked', messageOf(error)),
          })
        }}
      >
        Agents using it lose access right away.
      </ConfirmDialog>
    </Panel>
  )
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

function UsageView({ usage }: { usage: McpUsageOverview }) {
  const points = usage.days.map((day) => ({ ...day, ok: day.calls - day.errors }))
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Tool calls" value={usage.totals.calls} />
        <StatCard
          label="Failed"
          value={usage.totals.errors}
          accent={usage.totals.errors ? 'var(--danger)' : undefined}
        />
        <StatCard label="People" value={usage.totals.people} />
        <StatCard label="Packages asked about" value={usage.packages.length} />
      </div>
      <div
        className="h-56 w-full"
        role="img"
        aria-label={`MCP calls over ${usage.days.length} days, ${usage.totals.calls} in total`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="date"
              tickFormatter={dayLabel}
              tickLine={false}
              axisLine={false}
              minTickGap={32}
              tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={48}
              tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
            />
            <Tooltip
              cursor={{ fill: 'var(--chart-grid)' }}
              content={({ active, label }) => {
                const point = points.find((p) => p.date === label)
                if (!active || !point) return null
                return (
                  <div className="min-w-32 rounded-xl border border-border bg-overlay p-3 text-xs shadow-overlay">
                    <div className="mb-2 font-medium">{dayLabel(point.date)}</div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted">Calls</span>
                      <span className="tabular">{point.calls}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted">Failed</span>
                      <span className="tabular">{point.errors}</span>
                    </div>
                  </div>
                )
              }}
            />
            <Bar dataKey="ok" stackId="calls" fill="var(--accent)" radius={[0, 0, 0, 0]} />
            <Bar dataKey="errors" stackId="calls" fill="var(--danger)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <RankList
          title="Tools"
          rows={usage.tools.map((t) => ({
            key: t.tool,
            label: t.tool,
            calls: t.calls,
            note: t.errors ? `${t.errors} failed` : undefined,
          }))}
        />
        <RankList
          title="Packages"
          rows={usage.packages.map((p) => ({ key: p.name, label: p.name, calls: p.calls }))}
        />
        <RankList
          title="People and clients"
          rows={[
            ...usage.people.map((p) => ({ key: `p:${p.id}`, label: p.name, calls: p.calls })),
            ...usage.clients.map((c) => ({
              key: `c:${c.client}`,
              label: c.client,
              calls: c.calls,
              note: 'client',
            })),
          ]}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Recent calls</h3>
        {usage.recent.length ? (
          <Table label="Recent MCP calls">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Tool</Th>
                <Th>About</Th>
                <Th>Who</Th>
                <Th>Client</Th>
                <Th align="right">Time</Th>
              </tr>
            </thead>
            <tbody>
              {usage.recent.map((call, index) => (
                <tr key={`${call.at} ${index}`}>
                  <Td className="whitespace-nowrap text-muted">{formatRelative(call.at)}</Td>
                  <Td>
                    <span className="font-mono text-xs">{call.tool}</span>
                    {call.ok ? null : (
                      <Chip className="ml-2" tone="danger" size="sm">
                        failed
                      </Chip>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">{call.subject ?? '—'}</Td>
                  <Td>
                    {usage.people.find((p) => p.id === call.principal)?.name ?? call.principal}
                  </Td>
                  <Td className="text-xs text-muted">{call.client ?? '—'}</Td>
                  <Td align="right" className="tabular text-muted">
                    {call.durationMs} ms
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={<Bot />}
            title="No calls yet"
            description="Connect an agent with a token; its calls show up here."
          />
        )}
      </div>
    </div>
  )
}

function RankList({
  title,
  rows,
}: {
  title: string
  rows: { key: string; label: string; calls: number; note?: string | undefined }[]
}) {
  const max = Math.max(1, ...rows.map((row) => row.calls))
  return (
    <div className="rounded-2xl border border-border p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {rows.length ? (
        <ul className="flex flex-col gap-2">
          {rows.slice(0, 8).map((row) => (
            <li key={row.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-mono text-xs">{row.label}</span>
                <span className="tabular shrink-0 text-muted">
                  {row.calls}
                  {row.note ? <span className="ml-1 text-xs">· {row.note}</span> : null}
                </span>
              </div>
              <span className="h-1 overflow-hidden rounded-full bg-default">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${(row.calls / max) * 100}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nothing yet.</p>
      )}
    </div>
  )
}
