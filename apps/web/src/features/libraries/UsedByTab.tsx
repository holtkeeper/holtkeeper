import type { DependencyDetail, PackageUsageView, RepoRef, UsageSite } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Code2, PackageOpen } from 'lucide-react'
import { useState } from 'react'

import { usePackageUsage, useUsageSites } from '../../api/queries.ts'
import { behindLabel, behindTone } from '../../lib/dependencies.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import { upgradePrompt } from '../../lib/upgrade-prompt.ts'
import {
  type ConsumerRow,
  consumerRows,
  importPath,
  kindCounts,
  memberLabel,
  relativeCounts,
  snippetLines,
  unusedExports,
  usageKindLabels,
} from '../../lib/usages.ts'
import {
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  Legend,
  Panel,
  Placeholder,
  Strip,
  Tag,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'

const behindLegend = [
  { tone: 'success', label: 'current major' },
  { tone: 'warning', label: 'a major behind' },
  { tone: 'danger', label: '2+ behind' },
] as const

/** One use: where it is, how the export is used and the code around it. */
function SiteCard({
  site,
  repo,
  versions,
}: {
  site: UsageSite
  repo: RepoRef
  versions: string[]
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Link
          to="/repos/$"
          params={{ _splat: repoSplat(repo) }}
          className="mono font-medium text-foreground hover:underline"
        >
          {repoKey(repo)}
        </Link>
        {versions.length ? <span className="mono text-muted">{versions.join(', ')}</span> : null}
        <span className="mono text-muted">
          {site.file}:{site.line}
        </span>
        <Tag>{usageKindLabels[site.kind]}</Tag>
        {site.member ? <Tag mono>{memberLabel(site.member)}</Tag> : null}
        {site.props?.map((prop) => (
          <Tag key={prop} mono tone="info">
            {prop}
          </Tag>
        ))}
        {site.spread ? <Tag mono>{'{...spread}'}</Tag> : null}
        {site.typed ? <Tag tone="success">via types</Tag> : null}
      </div>
      <pre className="mono overflow-x-auto rounded-lg border border-line bg-sunk py-2 text-[12px] leading-relaxed">
        {snippetLines(site).map((line) => (
          <div key={line.number} className={`flex px-3 ${line.focus ? 'bg-raise' : ''}`}>
            <span className="tabular mr-3 w-8 shrink-0 select-none text-right text-dim">
              {line.number}
            </span>
            <span className="whitespace-pre">{line.text || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

function NameBars({
  title,
  items,
  selected,
  onSelect,
  format = (name: string) => name,
}: {
  title: string
  items: { name: string; count: number }[]
  selected?: string
  onSelect: (name: string) => void
  format?: (name: string) => string
}) {
  if (!items.length) return null
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-[11.5px] font-medium text-muted">{title}</div>
      {relativeCounts(items.slice(0, 20)).map((item) => (
        <button
          key={item.name}
          type="button"
          onClick={() => onSelect(item.name)}
          aria-pressed={selected === item.name}
          className={`relative flex items-center justify-between gap-2 overflow-hidden rounded-md px-2 py-1 text-left text-xs hover:bg-raise ${selected === item.name ? 'shadow-[0_0_0_1px_var(--line-strong)]' : ''}`}
        >
          <span
            className="absolute inset-y-0 left-0 bg-raise"
            style={{ width: `${item.share}%` }}
          />
          <span className="mono relative truncate">{format(item.name)}</span>
          <span className="tabular relative text-muted">{item.count}</span>
        </button>
      ))}
    </div>
  )
}

const consumerColumns = (newest: string | undefined): readonly FleetColumn<ConsumerRow>[] => [
  {
    id: 'repo',
    header: 'Repository',
    className: 'min-w-52',
    cell: (row) => (
      <Link to="/repos/$" params={{ _splat: repoSplat(row.repo) }} className="mono hover:underline">
        {row.repo.path}
      </Link>
    ),
  },
  {
    id: 'workspaces',
    header: 'Workspaces',
    cell: (row) =>
      row.workspaces.length ? (
        <span className="mono text-xs text-muted">{row.workspaces.join(', ')}</span>
      ) : (
        <span className="text-dim">—</span>
      ),
  },
  {
    id: 'version',
    header: 'Version',
    cell: (row) => (
      <span className="flex flex-wrap gap-1">
        {row.versions.map((version) => (
          <Tag key={version} mono tone={version === newest ? 'success' : 'default'}>
            {version}
          </Tag>
        ))}
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: (row) => <Tag tone={behindTone(row.majorsBehind)}>{behindLabel(row.majorsBehind)}</Tag>,
  },
  {
    id: 'exports',
    header: 'Exports used',
    align: 'right',
    cell: (row) => <span className="tabular">{row.exports ?? '—'}</span>,
  },
  {
    id: 'uses',
    header: 'Uses',
    align: 'right',
    cell: (row) => <span className="tabular">{row.uses ?? '—'}</span>,
  },
  {
    id: 'files',
    header: 'Files',
    align: 'right',
    cell: (row) => <span className="tabular">{row.files ?? '—'}</span>,
  },
  {
    id: 'read',
    header: 'Read',
    className: 'whitespace-nowrap',
    cell: (row) =>
      row.analyzedAt ? (
        <span className="text-muted">{formatRelative(row.analyzedAt)}</span>
      ) : (
        <span className="text-dim">—</span>
      ),
  },
]

/** One chip per repository with the versions it is on, tinted by how far behind it is. */
function RepoStrip({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly ConsumerRow[]
  selected: string | undefined
  onSelect: (repo: string | undefined) => void
}) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">Who uses which version</h2>
        <Legend items={behindLegend} label="Version legend" className="ms-auto" />
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {rows.map((row) => {
          const key = repoKey(row.repo)
          const current = key === selected
          return (
            <li key={key}>
              <button
                type="button"
                aria-pressed={current}
                onClick={() => onSelect(current ? undefined : key)}
                className={`flex items-center gap-2 rounded-md border px-2 py-1 text-left text-xs hover:bg-raise ${current ? 'border-line-strong bg-raise' : 'border-line'}`}
              >
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{
                    background: `var(--${row.majorsBehind === 0 ? 'ok' : row.majorsBehind === 1 ? 'warn' : 'bad'})`,
                  }}
                />
                <span className="mono">{row.repo.path}</span>
                <span className="mono text-muted">{row.versions.join(', ') || '—'}</span>
                <span className="sr-only">{behindLabel(row.majorsBehind)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

interface Selection {
  member?: string
  prop?: string
}

function ExportsAndCode({
  name,
  usage,
  repo,
  exportName,
  onExport,
  unused,
}: {
  name: string
  usage: PackageUsageView
  repo: string | undefined
  exportName: string | undefined
  onExport: (name: string | undefined) => void
  unused: readonly string[]
}) {
  const [selection, setSelection] = useState<Selection>({})
  const sites = useUsageSites(
    {
      package: name,
      ...(exportName ? { export: exportName } : {}),
      ...(selection.member ? { member: selection.member } : {}),
      ...(selection.prop ? { prop: selection.prop } : {}),
      ...(repo ? { repo } : {}),
    },
    exportName !== undefined,
  )
  const record = repo ? usage.repos.find((entry) => repoKey(entry.repo) === repo) : undefined
  const exports = repo ? (record?.exports ?? []) : usage.exports
  const pick = (next: string | undefined) => {
    setSelection({})
    onExport(next)
  }
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Panel
        title={repo ? `Exports used by ${repo}` : 'Exports used'}
        description="Pick an export, prop or member to see the code."
      >
        <div className="flex flex-col">
          {exports.map((item) => {
            const open = exportName === item.name
            return (
              <div
                key={`${item.subpath} ${item.name}`}
                className="flex flex-col gap-2 border-b border-line py-2.5 last:border-b-0"
              >
                <button
                  type="button"
                  aria-pressed={open}
                  onClick={() => pick(open ? undefined : item.name)}
                  className="flex flex-wrap items-center gap-2 text-left"
                >
                  <span className={`mono ${open ? 'font-semibold' : 'font-medium'}`}>
                    {item.name}
                  </span>
                  {item.subpath !== '.' ? (
                    <span className="mono text-xs text-muted">
                      {importPath(name, item.subpath)}
                    </span>
                  ) : null}
                  {kindCounts(item.kinds)
                    .slice(0, 3)
                    .map(({ kind, count }) => (
                      <Tag key={kind}>
                        {usageKindLabels[kind]} {count}
                      </Tag>
                    ))}
                  <span className="tabular ml-auto text-xs text-muted">
                    {plural(item.count, 'use')}
                    {'repos' in item ? ` · ${plural(item.repos.length, 'repo')}` : ''}
                  </span>
                </button>
                {open && (item.props.length || item.members.length) ? (
                  <div className="grid gap-3 pb-1 sm:grid-cols-2">
                    <NameBars
                      title="Props"
                      items={item.props}
                      {...(selection.prop ? { selected: selection.prop } : {})}
                      onSelect={(prop) => setSelection(selection.prop === prop ? {} : { prop })}
                    />
                    <NameBars
                      title="Members"
                      items={item.members}
                      format={memberLabel}
                      {...(selection.member ? { selected: selection.member } : {})}
                      onSelect={(member) =>
                        setSelection(selection.member === member ? {} : { member })
                      }
                    />
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        {unused.length && !repo ? (
          <div className="mt-3 flex flex-col gap-2">
            <div className="text-[11.5px] font-medium text-muted">
              Not used by any analysed repository ({unused.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {unused.slice(0, 60).map((symbol) => (
                <Tag key={symbol} mono>
                  {symbol}
                </Tag>
              ))}
              {unused.length > 60 ? <span className="text-xs text-muted">…</span> : null}
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel
        title={
          exportName
            ? `${exportName}${selection.member ? memberLabel(selection.member) : ''}${selection.prop ? ` · ${selection.prop}` : ''}`
            : 'Code'
        }
        description={
          sites.data
            ? `${plural(sites.data.sites.length, 'snippet')}${sites.data.total > sites.data.sites.length ? ` of ${plural(sites.data.total, 'use')}; records keep a sample per export` : ''}.`
            : undefined
        }
      >
        {!exportName ? (
          <EmptyState
            icon={<Code2 />}
            title="Pick an export"
            description="Its uses show up here with the code around them."
          />
        ) : sites.isPending ? (
          <Placeholder className="h-64" />
        ) : sites.isError ? (
          <ErrorState error={sites.error} />
        ) : sites.data.sites.length ? (
          <div>
            {sites.data.sites.map((found) => (
              <SiteCard
                key={`${repoKey(found.origin)} ${found.site.file} ${found.site.line} ${found.site.column} ${found.export}`}
                site={found.site}
                repo={found.origin}
                versions={found.versions}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No snippet kept"
            description="Records keep a sample of sites per export."
          />
        )}
      </Panel>
    </div>
  )
}

interface UsedByProps {
  detail: DependencyDetail
  /** `forge:path` everything narrows to. */
  repo: string | undefined
  /** The export whose code is shown. */
  exportName: string | undefined
  /** Only consumers on this version. */
  using: string | undefined
  onRepo: (repo: string | undefined) => void
  onExport: (name: string | undefined) => void
  onUsing: (version: string | undefined) => void
  /** Entry points of an internal package whose API is on record, for the exports nobody uses. */
  entries?: readonly { symbols: readonly { name: string; kind: string }[] }[]
}

function UsedByBody({ usage, ...props }: UsedByProps & { usage: PackageUsageView | undefined }) {
  const { detail, repo, onRepo, using } = props
  const { view, setView, homeGroups } = useScope()
  const all = consumerRows(detail.usedBy, usage?.repos)
  const rows = using ? all.filter((row) => row.versions.includes(using)) : all
  const prompt = () =>
    upgradePrompt({
      name: detail.name,
      ecosystem: detail.ecosystem,
      ...(detail.latest ? { to: detail.latest } : {}),
      repos: rows.map((row) => ({ repo: repoKey(row.repo), versions: row.versions })),
    })
  if (!all.length)
    return (
      <EmptyState
        icon={<PackageOpen />}
        title="No analysed repository uses this library"
        description="The depgraph and usages analyzers record which libraries each repository uses and what of them; they run weekly on default branches."
      />
    )
  const newest = usage?.versions[0] ?? detail.latest
  const uses = usage?.repos.reduce((sum, entry) => sum + entry.count, 0)
  const workspaces = rows.reduce((sum, row) => sum + Math.max(1, row.workspaces.length), 0)
  const unused =
    usage && props.entries
      ? unusedExports(
          props.entries,
          usage.exports.map((item) => item.name),
        )
      : undefined
  const used = usage?.exports.length
  const exported = props.entries ? unusedExports(props.entries, []).length : undefined
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <Strip
          className="border-b-0"
          cells={[
            {
              value: rows.length,
              label: 'repositories',
              ...(usage ? { caption: `· ${plural(workspaces, 'workspace')}` } : {}),
            },
            { value: detail.versions.length, label: 'versions in use' },
            ...(used !== undefined
              ? [
                  {
                    value: exported !== undefined ? `${used} of ${exported}` : used,
                    label: 'exports used',
                  },
                ]
              : []),
            ...(uses !== undefined
              ? [{ value: uses, label: 'uses', caption: '· calls, JSX, types, members' }]
              : []),
            {
              value: rows.filter((row) => row.majorsBehind > 0).length,
              label: 'repositories a major behind',
              tone: 'warning' as const,
            },
            ...(usage?.indexedAt
              ? [
                  {
                    prefix: 'Usage read',
                    value: formatRelative(usage.indexedAt),
                    label: '',
                    end: true,
                  },
                ]
              : []),
          ]}
        />
      </div>
      <RepoStrip rows={rows} selected={repo} onSelect={onRepo} />
      <FleetTable<ConsumerRow>
        label="Consumers"
        rows={rows}
        rowKey={(row) => repoKey(row.repo)}
        columns={consumerColumns(newest)}
        scope={{ value: view, onChange: setView, homeGroups }}
        onOpen={(row) => onRepo(repoKey(row.repo) === repo ? undefined : repoKey(row.repo))}
        toolbar={
          <>
            {usage?.exports.length ? (
              <FilterButton
                single
                label="Export"
                all="All"
                options={usage.exports.map((item) => ({ id: item.name, label: item.name }))}
                value={props.exportName ? [props.exportName] : []}
                onChange={([name]) => props.onExport(name)}
              />
            ) : null}
            <FilterButton
              single
              label="Version"
              options={detail.versions.map((version) => ({
                id: version.version,
                label: version.version,
              }))}
              value={using ? [using] : []}
              onChange={([version]) => props.onUsing(version)}
            />
            {repo ? (
              <Button size="sm" variant="ghost" onPress={() => onRepo(undefined)}>
                All repositories
              </Button>
            ) : null}
            <CopyButton text={prompt} variant="ghost">
              Copy as prompt
            </CopyButton>
          </>
        }
        caption="· most behind first; a row narrows the exports to it"
      />
      {usage?.exports.length ? (
        <ExportsAndCode
          name={detail.name}
          usage={usage}
          repo={repo}
          exportName={props.exportName}
          onExport={props.onExport}
          unused={unused ?? []}
        />
      ) : null}
    </div>
  )
}

function NpmUsedBy(props: UsedByProps) {
  const usage = usePackageUsage(props.detail.name)
  if (usage.isPending) return <Placeholder className="h-96" />
  if (usage.isError) return <ErrorState error={usage.error} />
  return <UsedByBody {...props} usage={usage.data} />
}

/**
 * Who uses the library: a summary, one chip per repository with its versions, the consumers
 * table with other teams folded, and for npm the exports they use with the code of the picked
 * export, prop or member.
 */
export function UsedByTab(props: UsedByProps) {
  return props.detail.ecosystem === 'npm' ? (
    <NpmUsedBy {...props} />
  ) : (
    <UsedByBody {...props} usage={undefined} />
  )
}
