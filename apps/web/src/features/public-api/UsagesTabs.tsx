import type { PublicApiPackageDetail, RepoRef, UsageSite } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Boxes, Code2, GitBranch, PackageOpen } from 'lucide-react'
import { useState } from 'react'

import {
  usePackageUsage,
  useRepoUsage,
  useUpgradeImpact,
  useUsageSites,
} from '../../api/queries.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { versionKey, versionLabel } from '../../lib/public-api.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  impactTone,
  kindCounts,
  memberLabel,
  relativeCounts,
  snippetLines,
  usageKindLabels,
} from '../../lib/usages.ts'
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Panel,
  Placeholder,
  Select,
  StatCard,
  Table,
  Td,
  Th,
} from '../../ui/index.ts'

const importPath = (name: string, subpath: string) =>
  subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`

/** One use: where it is, how the export is used and the code around it. */
function SiteCard({
  site,
  repo,
  versions,
  label,
}: {
  site: UsageSite
  repo?: RepoRef
  versions?: string[]
  label?: string
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {repo ? (
          <Link
            to="/repos/view"
            search={{ repo: repoKey(repo) }}
            className="font-medium text-foreground hover:underline"
          >
            {repoKey(repo)}
          </Link>
        ) : null}
        {versions?.length ? (
          <span className="tabular text-muted">{versions.join(', ')}</span>
        ) : null}
        <span className="font-mono text-muted">
          {site.file}:{site.line}
        </span>
        {label ? <span className="font-mono font-medium">{label}</span> : null}
        <Chip size="sm">{usageKindLabels[site.kind]}</Chip>
        {site.member ? (
          <Chip size="sm" variant="soft">
            <span className="font-mono">{memberLabel(site.member)}</span>
          </Chip>
        ) : null}
        {site.props?.map((prop) => (
          <Chip key={prop} size="sm" variant="soft" tone="accent">
            <span className="font-mono">{prop}</span>
          </Chip>
        ))}
        {site.spread ? (
          <Chip size="sm" variant="soft">
            <span className="font-mono">{'{...spread}'}</span>
          </Chip>
        ) : null}
        {site.typed ? (
          <Chip size="sm" tone="success" variant="soft">
            via types
          </Chip>
        ) : null}
      </div>
      <pre className="overflow-x-auto rounded-xl border border-border bg-default py-2 font-mono text-[12.5px] leading-relaxed">
        {snippetLines(site).map((line) => (
          <div key={line.number} className={`flex px-3 ${line.focus ? 'bg-accent/10' : ''}`}>
            <span className="tabular mr-3 w-8 shrink-0 select-none text-right text-muted">
              {line.number}
            </span>
            <span className="whitespace-pre">{line.text || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

interface Selection {
  export: string
  member?: string
  prop?: string
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
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{title}</div>
      {relativeCounts(items.slice(0, 20)).map((item) => (
        <button
          key={item.name}
          type="button"
          onClick={() => onSelect(item.name)}
          className={`relative flex items-center justify-between gap-2 overflow-hidden rounded-lg px-2 py-1 text-left text-xs hover:bg-default ${selected === item.name ? 'ring-1 ring-accent' : ''}`}
        >
          <span
            className="absolute inset-y-0 left-0 bg-accent/10"
            style={{ width: `${item.share}%` }}
          />
          <span className="relative truncate font-mono">{format(item.name)}</span>
          <span className="tabular relative text-muted">{item.count}</span>
        </button>
      ))}
    </div>
  )
}

/** Who uses the package, at which versions, which of its exports, members and props, and where. */
export function UsedByTab({ data }: { data: PublicApiPackageDetail }) {
  const name = data.package.name
  const usage = usePackageUsage(name)
  const [repo, setRepo] = useState<string | undefined>(undefined)
  const [selection, setSelection] = useState<Selection | undefined>(undefined)
  const sites = useUsageSites(
    {
      package: name,
      ...(selection?.export ? { export: selection.export } : {}),
      ...(selection?.member ? { member: selection.member } : {}),
      ...(selection?.prop ? { prop: selection.prop } : {}),
      ...(repo ? { repo } : {}),
    },
    selection !== undefined,
  )

  if (usage.isPending) return <Placeholder className="h-96" />
  if (usage.isError) return <ErrorState error={usage.error} />
  const view = usage.data
  if (!view.repos.length)
    return (
      <EmptyState
        icon={<PackageOpen />}
        title="No analyzed repository uses this package"
        description="The usages analyzer records which packages each repository imports and what it uses of them; it runs weekly on default branches."
      />
    )

  const exported = data.package.entries.flatMap((entry) =>
    entry.symbols.filter((s) => s.kind !== 'reexport').map((s) => s.name),
  )
  const used = new Set(view.exports.map((item) => item.name))
  const unused = [...new Set(exported)].filter((symbol) => !used.has(symbol))
  const exportsShown = repo
    ? (view.repos.find((r) => repoKey(r.repo) === repo)?.exports ?? []).map((item) => ({
        ...item,
        repos: [view.repos.find((r) => repoKey(r.repo) === repo)?.repo].filter(
          (r): r is RepoRef => r !== undefined,
        ),
      }))
    : view.exports
  const uses = view.repos.reduce((sum, r) => sum + r.count, 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Repositories" value={view.repos.length} icon={<GitBranch />} />
        <StatCard
          label="Versions in use"
          value={view.versions.length}
          hint={view.versions.slice(0, 4).join(', ') || 'unknown'}
        />
        <StatCard
          label="Exports used"
          value={view.exports.length}
          hint={exported.length ? `of ${plural(new Set(exported).size, 'export')}` : undefined}
          icon={<Boxes />}
        />
        <StatCard label="Uses" value={uses} hint="calls, JSX, types, members" icon={<Code2 />} />
      </div>

      <Panel
        title="Repositories"
        description={
          view.indexedAt
            ? `Newest usage record of each repository; read ${formatRelative(view.indexedAt)}.`
            : undefined
        }
        actions={
          repo ? (
            <Button size="sm" variant="ghost" onPress={() => setRepo(undefined)}>
              All repositories
            </Button>
          ) : null
        }
      >
        <Table label="Repositories using the package">
          <thead>
            <tr>
              <Th>Repository</Th>
              <Th>Version</Th>
              <Th>Workspaces</Th>
              <Th align="right">Uses</Th>
              <Th align="right">Files</Th>
              <Th align="right">Exports</Th>
              <Th>Analyzed</Th>
            </tr>
          </thead>
          <tbody>
            {view.repos.map((item) => {
              const key = repoKey(item.repo)
              return (
                <tr
                  key={key}
                  className={`cursor-pointer hover:bg-default/40 ${repo === key ? 'bg-default/60' : ''}`}
                  onClick={() => setRepo(repo === key ? undefined : key)}
                >
                  <Td>
                    <span className="font-medium">{key}</span>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {(item.versions.length ? item.versions : item.ranges).map((version) => (
                        <Chip
                          key={version}
                          size="sm"
                          tone={version === view.versions[0] ? 'success' : 'warning'}
                        >
                          {version}
                        </Chip>
                      ))}
                    </div>
                  </Td>
                  <Td className="text-muted">
                    {item.workspaces.filter((w) => w !== 'root').join(', ') || '—'}
                  </Td>
                  <Td align="right" className="tabular">
                    {item.count}
                  </Td>
                  <Td align="right" className="tabular">
                    {item.files}
                  </Td>
                  <Td align="right" className="tabular">
                    {item.exports.length}
                  </Td>
                  <Td className="whitespace-nowrap text-muted">
                    {formatRelative(item.analyzedAt)}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Panel
          title={repo ? `Exports used by ${repo}` : 'Exports used'}
          description="Pick an export, prop or member to see the code."
        >
          <div className="flex flex-col">
            {exportsShown.map((item) => {
              const open = selection?.export === item.name
              return (
                <div
                  key={`${item.subpath} ${item.name}`}
                  className="flex flex-col gap-2 border-b border-border py-2.5 last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSelection(
                        open && !selection?.member && !selection?.prop
                          ? undefined
                          : { export: item.name },
                      )
                    }
                    className="flex flex-wrap items-center gap-2 text-left"
                  >
                    <span className={`font-mono text-sm ${open ? 'font-semibold' : 'font-medium'}`}>
                      {item.name}
                    </span>
                    {item.subpath !== '.' ? (
                      <span className="font-mono text-xs text-muted">
                        {importPath(name, item.subpath)}
                      </span>
                    ) : null}
                    {kindCounts(item.kinds)
                      .slice(0, 3)
                      .map(({ kind, count }) => (
                        <Chip key={kind} size="sm">
                          {usageKindLabels[kind]} {count}
                        </Chip>
                      ))}
                    <span className="tabular ml-auto text-xs text-muted">
                      {plural(item.count, 'use')}
                      {repo ? '' : ` · ${plural(item.repos.length, 'repo')}`}
                    </span>
                  </button>
                  {open && (item.props.length || item.members.length) ? (
                    <div className="grid gap-3 pb-1 sm:grid-cols-2">
                      <NameBars
                        title="Props"
                        items={item.props}
                        {...(selection?.prop ? { selected: selection.prop } : {})}
                        onSelect={(prop) =>
                          setSelection(
                            selection?.prop === prop
                              ? { export: item.name }
                              : { export: item.name, prop },
                          )
                        }
                      />
                      <NameBars
                        title="Members"
                        items={item.members}
                        format={memberLabel}
                        {...(selection?.member ? { selected: selection.member } : {})}
                        onSelect={(member) =>
                          setSelection(
                            selection?.member === member
                              ? { export: item.name }
                              : { export: item.name, member },
                          )
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
              <div className="text-xs font-medium uppercase tracking-wide text-muted">
                Not used by any analyzed repository ({unused.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {unused.slice(0, 60).map((symbol) => (
                  <Chip key={symbol} size="sm" variant="soft">
                    <span className="font-mono">{symbol}</span>
                  </Chip>
                ))}
                {unused.length > 60 ? <span className="text-xs text-muted">…</span> : null}
              </div>
            </div>
          ) : null}
        </Panel>

        <Panel
          title={
            selection
              ? `${selection.export}${selection.member ? memberLabel(selection.member) : ''}${selection.prop ? ` · ${selection.prop}` : ''}`
              : 'Code'
          }
          description={
            sites.data
              ? `${plural(sites.data.sites.length, 'snippet')}${sites.data.total > sites.data.sites.length ? ` of ${plural(sites.data.total, 'use')}; records keep a sample per export` : ''}.`
              : undefined
          }
        >
          {!selection ? (
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
    </div>
  )
}

/** What upgrading from an older version to the shown one breaks in the repositories using it. */
export function ImpactTab({ data }: { data: PublicApiPackageDetail }) {
  const current = data.versions.find((v) => v.analysisId === data.analysisId)
  const older = data.versions.filter(
    (v) => !v.head && v.analysisId !== data.analysisId && v.analyzedAt <= data.analyzedAt,
  )
  const [from, setFrom] = useState<string | undefined>(undefined)
  const fromKey = from ?? (older.at(-1) ? versionKey(older.at(-1)!) : undefined)
  const impact = useUpgradeImpact(
    {
      package: data.package.name,
      to: current ? versionKey(current) : 'latest',
      repo: repoKey(data.repo),
      ...(fromKey ? { from: fromKey } : {}),
    },
    fromKey !== undefined,
  )

  if (!fromKey)
    return (
      <EmptyState
        title="No earlier version on record"
        description="Upgrade impact compares two recorded versions of the API with how repositories use it."
      />
    )
  const result = impact.data
  return (
    <Panel
      title={
        result
          ? `${result.from.version} → ${current ? versionLabel(current) : result.to.version}`
          : 'Upgrade impact'
      }
      description={
        result
          ? result.impact.items.length
            ? `${plural(result.impact.affected.length, 'repository', 'repositories')} affected, ${plural(result.impact.unaffected.length, 'repository', 'repositories')} unaffected. Repositories already on the target version are left out.`
            : 'No analyzed use is affected by these changes.'
          : undefined
      }
      actions={
        <Select
          aria-label="Upgrade from"
          className="w-56"
          value={fromKey}
          onChange={setFrom}
          options={older.map((v) => ({
            id: versionKey(v),
            label: `from ${versionLabel(v)}`,
            text: versionLabel(v),
          }))}
        />
      }
    >
      {impact.isPending ? (
        <Placeholder className="h-48" />
      ) : impact.isError ? (
        <ErrorState error={impact.error} />
      ) : result ? (
        result.impact.items.length ? (
          <div className="flex flex-col gap-4">
            {result.impact.items.map((item) => (
              <div
                key={`${item.change.change} ${item.change.subpath} ${item.change.name}`}
                className="flex flex-col gap-2 border-b border-border pb-4 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={impactTone[item.level]} size="sm">
                    {item.level}
                  </Chip>
                  <span className="text-sm text-muted">{item.change.change}</span>
                  <span className="font-mono text-sm font-medium">{item.change.name}</span>
                  {item.removedMembers?.map((member) => (
                    <Chip key={member} size="sm" variant="soft" tone="danger">
                      <span className="font-mono line-through">{member}</span>
                    </Chip>
                  ))}
                  <span className="tabular ml-auto text-xs text-muted">
                    {plural(item.count, 'use')} in {plural(item.repos.length, 'repo')}
                  </span>
                </div>
                {item.repos.map((repoImpact) => (
                  <div
                    key={repoKey(repoImpact.origin)}
                    className="ml-1 border-l border-border pl-3"
                  >
                    <div className="text-xs text-muted">
                      {repoImpact.via ? `through ${repoImpact.via}` : null}
                      {repoImpact.members ? ` · touches ${repoImpact.members.join(', ')}` : null}
                    </div>
                    {repoImpact.sites.map((site) => (
                      <SiteCard
                        key={`${site.file} ${site.line} ${site.column}`}
                        site={site}
                        repo={repoImpact.origin}
                        versions={repoImpact.versions}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Nothing breaks"
            description="No analyzed repository uses what changed between these versions."
          />
        )
      ) : null}
    </Panel>
  )
}

/** The packages one repository's code imports, with versions and how much of each it uses. */
export function RepoPackagesTab({ repo }: { repo: RepoRef }) {
  const usage = useRepoUsage(repoKey(repo))
  if (usage.isPending) return <Placeholder className="h-64" />
  if (usage.isError)
    return (
      <EmptyState
        icon={<PackageOpen />}
        title="No usage record yet"
        description="The usages analyzer records which packages this repository imports and what it uses of them; it runs weekly on the default branch."
      />
    )
  const view = usage.data
  return (
    <Panel
      title="Packages used"
      description={`${plural(view.packages.length, 'package')} imported from ${plural(view.files, 'file')}; analyzed ${formatRelative(view.analyzedAt)}${view.types.status === 'used' ? ', with the type checker' : `, imports only (type checker ${view.types.status}${view.types.reason ? `: ${view.types.reason}` : ''})`}.`}
    >
      <Table label="Packages used">
        <thead>
          <tr>
            <Th>Package</Th>
            <Th>Version</Th>
            <Th align="right">Uses</Th>
            <Th align="right">Files</Th>
            <Th align="right">Exports</Th>
          </tr>
        </thead>
        <tbody>
          {view.packages.map((pkg) => (
            <tr key={pkg.name} className="hover:bg-default/40">
              <Td>
                <Link
                  to="/public-api"
                  search={{ package: pkg.name }}
                  className="font-mono text-[13px] font-medium hover:underline"
                >
                  {pkg.name}
                </Link>
                {pkg.local ? (
                  <Chip className="ml-2" size="sm">
                    defined here
                  </Chip>
                ) : null}
              </Td>
              <Td className="tabular">
                {pkg.versions.join(', ') || (
                  <span className="text-muted">{pkg.ranges.join(', ') || '—'}</span>
                )}
              </Td>
              <Td align="right" className="tabular">
                {pkg.count}
              </Td>
              <Td align="right" className="tabular">
                {pkg.files}
              </Td>
              <Td align="right" className="tabular">
                {pkg.exports}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  )
}
