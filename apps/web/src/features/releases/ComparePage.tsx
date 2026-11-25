import type {
  DependencyDiff,
  DependencyRoot,
  ReleaseCompareRefs,
  ReleaseCompareView,
  RepoRef,
} from '@holtkeeper/api'
import { Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowLeftRight, ChevronDown, ChevronRight, ExternalLink, Sparkles } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useReleaseCompare,
  useReleaseCompareSummary,
  useReleaseOverview,
  useReleaseRefs,
} from '../../api/queries.ts'
import { actionFirst } from '../../lib/release-overview.ts'
import { countLabel } from '../../lib/releases.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { searchText } from '../../lib/search-params.ts'
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Markdown,
  Notice,
  Page,
  Panel,
  Placeholder,
  Select,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { packageQuery } from './compare-impact.ts'
import {
  type CompareRange,
  changeTones,
  defaultRange,
  dependencyChangeCount,
  directCounts,
  hasWorkspaces,
  rangeProblem,
  rootFacts,
  rootLabel,
  sameRange,
  sideRange,
  sideText,
  swapRange,
  targetBranch,
  transitiveCounts,
} from './compare-range.ts'
import { BreakingCheckCard, PackageChanges, PublicApiSection } from './CompareImpact.tsx'
import { BumpTag, ReleaseRepoSwitch, TaskList } from './parts.tsx'

type Option = { id: string; label: ReactNode; text: string }

type Refs = Pick<ReleaseCompareRefs, 'versions' | 'branches'>

const noRefs: Refs = { versions: [], branches: [] }

function rangeOptions(refs: Refs, range: CompareRange) {
  const versions: Option[] = refs.versions.map((version) => ({
    id: version.tag,
    label: (
      <span className="flex items-center gap-2">
        <span className="mono">{version.tag}</span>
        {version.prerelease ? <span className="text-xs text-muted">prerelease</span> : null}
      </span>
    ),
    text: version.tag,
  }))
  const target = targetBranch(refs)
  const to: Option[] = [
    ...(target
      ? [
          {
            id: target,
            label: (
              <span className="flex items-center gap-2">
                <span className="mono">{target}</span>
                <span className="text-xs text-muted">target branch — unreleased</span>
              </span>
            ),
            text: target,
          },
        ]
      : []),
    ...versions,
  ]
  const from = [...versions]
  const extra = (options: Option[], ref: string | undefined) => {
    if (ref !== undefined && !options.some((option) => option.id === ref))
      options.unshift({ id: ref, label: <span className="mono">{ref}</span>, text: ref })
  }
  extra(from, range.from)
  extra(to, range.to)
  return { from, to }
}

function RangePicker({
  refs,
  range,
  onChange,
}: {
  refs: Refs
  range: CompareRange
  onChange: (range: CompareRange) => void
}) {
  const options = rangeOptions(refs, range)
  const problem = rangeProblem(refs, range)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label="From (older)"
          placeholder="The version before To"
          className="w-60 max-w-full"
          options={options.from}
          value={range.from}
          onChange={(from) =>
            onChange({ from, ...(range.to !== undefined ? { to: range.to } : {}) })
          }
        />
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label="Swap the ends"
          isDisabled={range.from === undefined || range.to === undefined}
          onPress={() => onChange(swapRange(range))}
        >
          <ArrowLeftRight className="size-3.5" />
        </Button>
        <Select
          label="To (newer)"
          className="w-72 max-w-full"
          options={options.to}
          value={range.to}
          onChange={(to) => onChange(defaultRange(refs, { to }))}
        />
      </div>
      {problem ? (
        <Notice tone="warning" title="Check the range">
          {problem}
        </Notice>
      ) : null}
    </div>
  )
}

function Stats({ view }: { view: ReleaseCompareView }) {
  const dependencyChanges = view.dependencies ? dependencyChangeCount(view.dependencies) : undefined
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span>
        <span className="mono">{view.from ?? 'first commit'}</span>
        <span className="text-muted"> → </span>
        <span className="mono">{view.to}</span>
      </span>
      {view.unreleased ? <Tag tone="warning">Unreleased</Tag> : null}
      <BumpTag bump={view.bump} />
      <span className="text-muted">{countLabel(view.commitCount, view.capped)}</span>
      <span className="text-muted">{countLabel(view.tasks.length, false, 'task')}</span>
      {dependencyChanges !== undefined ? (
        <span className="text-muted">
          {countLabel(dependencyChanges, false, 'dependency change')}
        </span>
      ) : null}
      <span className="flex-1" />
      {view.compareUrl ? (
        <a
          href={view.compareUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-6 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-muted hover:border-line-strong hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
          Compare on the forge
        </a>
      ) : null}
    </div>
  )
}

function SummaryCard({ repo, range }: { repo: RepoRef; range: CompareRange }) {
  const summary = useReleaseCompareSummary()
  const [code, setCode] = useState(false)
  const describe = () =>
    summary.mutate({
      repo: repoKey(repo),
      ...(range.from !== undefined ? { from: range.from } : {}),
      ...(range.to !== undefined ? { to: range.to } : {}),
      code,
    })
  return (
    <Panel
      variant="flush"
      title="What changed"
      description={
        summary.data
          ? [
              summary.data.code
                ? 'From commits, dependencies and code'
                : 'From commits and dependencies',
              summary.data.cached ? 'kept from an earlier request' : undefined,
            ]
              .filter(Boolean)
              .join(' · ')
          : 'An AI description of the commits and dependency changes, optionally of the code diff too.'
      }
      actions={
        <>
          <Checkbox
            label="Include code changes"
            isSelected={code}
            onChange={setCode}
            isDisabled={summary.isPending}
          />
          <Button size="sm" isPending={summary.isPending} onPress={describe}>
            <Sparkles className="size-3.5" />
            {summary.data ? 'Describe again' : 'Describe changes'}
          </Button>
        </>
      }
    >
      {summary.isError ? (
        <Notice tone="danger" title="Not described">
          {messageOf(summary.error)}
        </Notice>
      ) : summary.isPending ? (
        <Placeholder className="h-24" />
      ) : summary.data ? (
        <Markdown text={summary.data.markdown} />
      ) : null}
    </Panel>
  )
}

function Versions({ from, to }: { from?: string[]; to?: string[] }) {
  return (
    <span className="mono text-xs">
      {from?.length ? <span className="text-muted">{from.join(', ')}</span> : null}
      {from?.length && to?.length ? <span className="text-dim"> → </span> : null}
      {to?.length ? <span>{to.join(', ')}</span> : null}
    </span>
  )
}

function RootView({ repo, root }: { repo: RepoRef; root: DependencyRoot }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const workspaces = hasWorkspaces(root)
  const columns = workspaces ? 6 : 5
  const direct = directCounts(root.counts)
  const transitive = transitiveCounts(root.counts)
  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="mono text-sm font-semibold">{rootLabel(root)}</h3>
        <span className="text-xs text-muted">{rootFacts(root)}</span>
        {direct ? <span className="text-xs text-dim">Direct: {direct}</span> : null}
      </header>
      {root.errors.map((error) => (
        <Notice key={error} tone="warning" title="Partly read">
          {error}
        </Notice>
      ))}
      {root.direct.length ? (
        <Table label={`Direct dependency changes in ${rootLabel(root)}`}>
          <thead>
            <tr>
              <Th>Package</Th>
              {workspaces ? <Th>Workspace</Th> : null}
              <Th>Field</Th>
              <Th>Version</Th>
              <Th>Change</Th>
              <Th>
                <span className="sr-only">Details</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {root.direct.map((change) => {
              const key = `${change.workspace}:${change.field}:${change.name}`
              const query = packageQuery(root, change)
              const expanded = query !== undefined && open.has(key)
              return (
                <Fragment key={key}>
                  <Tr>
                    <Td>
                      <span className="mono">{change.name}</span>
                    </Td>
                    {workspaces ? (
                      <Td>
                        <span className="mono text-xs text-muted">{change.workspace}</span>
                      </Td>
                    ) : null}
                    <Td>
                      <span className="text-xs text-muted">{change.field}</span>
                    </Td>
                    <Td>
                      <span className="mono text-xs">
                        {change.from ? (
                          <span className="text-muted" title={sideRange(change.from)}>
                            {sideText(change.from)}
                          </span>
                        ) : null}
                        {change.from && change.to ? <span className="text-dim"> → </span> : null}
                        {change.to ? (
                          <span title={sideRange(change.to)}>{sideText(change.to)}</span>
                        ) : null}
                        {sideRange(change.to) && sideRange(change.to) !== sideRange(change.from) ? (
                          <span className="text-dim"> ({sideRange(change.to)})</span>
                        ) : null}
                      </span>
                    </Td>
                    <Td>
                      <Tag tone={changeTones[change.change]}>{change.change}</Tag>
                    </Td>
                    <Td>
                      {query ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded}
                          onPress={() => toggle(key)}
                        >
                          {expanded ? (
                            <ChevronDown className="size-3.5" />
                          ) : (
                            <ChevronRight className="size-3.5" />
                          )}
                          What changed
                        </Button>
                      ) : null}
                    </Td>
                  </Tr>
                  {expanded ? (
                    <tr>
                      <td
                        colSpan={columns}
                        className="border-b border-separator bg-raise px-3.5 py-3"
                      >
                        <PackageChanges repo={repo} query={query} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </Table>
      ) : (
        <p className="text-sm text-muted">No direct dependency changed.</p>
      )}
      {root.transitive.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted">
            Transitive: {transitive}
            {root.transitiveCapped ? ` · first ${root.transitive.length} shown` : ''}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {root.transitive.map((change) => (
              <li key={change.name} className="flex flex-wrap items-baseline gap-2">
                <span className="mono">{change.name}</span>
                <Versions
                  {...(change.from ? { from: change.from } : {})}
                  {...(change.to ? { to: change.to } : {})}
                />
                <Tag tone={changeTones[change.change]}>{change.change}</Tag>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}

function Dependencies({
  repo,
  diff,
  unavailable,
}: {
  repo: RepoRef
  diff: DependencyDiff | null
  unavailable?: string
}) {
  if (!diff)
    return (
      <p className="text-sm text-muted">
        Dependencies were not read{unavailable ? `: ${unavailable}` : ''}.
      </p>
    )
  return (
    <div className="flex flex-col gap-5">
      {diff.partial ? (
        <p className="text-xs text-muted">
          The forge listed only part of the changed files, so some roots may be missing.
        </p>
      ) : null}
      {diff.roots.length ? (
        diff.roots.map((root) => (
          <RootView key={`${root.ecosystem}:${root.path}`} repo={repo} root={root} />
        ))
      ) : (
        <p className="text-sm text-muted">No dependency changes.</p>
      )}
      {diff.skipped ? (
        <p className="text-xs text-muted">
          {countLabel(diff.skipped, false, 'more root')} not read.
        </p>
      ) : null}
    </div>
  )
}

function Body({
  repo,
  refs,
  range,
  onRange,
}: {
  repo: RepoRef
  refs: Refs | undefined
  range: CompareRange
  onRange: (range: CompareRange) => void
}) {
  const view = useReleaseCompare(repo, range)
  return (
    <div className="flex flex-col gap-5">
      <RangePicker refs={refs ?? noRefs} range={range} onChange={onRange} />
      {view.isPending ? (
        <div className="flex flex-col gap-3">
          <Placeholder className="h-8" />
          <Placeholder className="h-48" />
        </div>
      ) : view.isError ? (
        <ErrorState error={view.error} />
      ) : (
        <>
          <Stats view={view.data} />
          {view.data.summaryAvailable ? (
            <SummaryCard
              key={`${repoKey(repo)}:${range.from ?? ''}:${range.to ?? ''}`}
              repo={repo}
              range={range}
            />
          ) : null}
          <BreakingCheckCard
            key={`check:${repoKey(repo)}:${range.from ?? ''}:${range.to ?? ''}`}
            repo={repo}
            range={range}
            canRun={view.data.summaryAvailable}
          />
          <PublicApiSection repo={repo} range={range} />
          <Panel variant="flush" title={`Tasks · ${view.data.tasks.length}`}>
            <TaskList tasks={view.data.tasks} />
          </Panel>
          <Panel variant="flush" title="Changelog">
            {view.data.changelog.trim() ? (
              <Markdown text={view.data.changelog} />
            ) : (
              <p className="text-sm text-muted">No changes.</p>
            )}
          </Panel>
          <Panel variant="flush" title="Dependencies">
            <Dependencies
              repo={repo}
              diff={view.data.dependencies}
              {...(view.data.dependenciesUnavailable
                ? { unavailable: view.data.dependenciesUnavailable }
                : {})}
            />
          </Panel>
        </>
      )}
    </div>
  )
}

/**
 * Releases › Compare for the repository in `?repo=` (without one it opens the first repository of
 * the Overview, action first): two ends picked from the version tags and the target branch
 * (`?from=&to=`, defaulting to the latest version and the one before it), then the commit count,
 * bump and forge link, an AI description on request, the AI breaking-change check, the public API
 * changes of the repository's own packages, the tasks, the changelog and the dependency changes of
 * every lockfile root, each updated or added direct dependency folding out what changed in it.
 */
export function ComparePage() {
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const repo = parseRepoKey(search.repo)
  const refs = useReleaseRefs(repo)
  const overview = useReleaseOverview()
  const asked: CompareRange = {
    ...(searchText(search.from) ? { from: searchText(search.from) } : {}),
    ...(searchText(search.to) ? { to: searchText(search.to) } : {}),
  }
  const first = overview.data ? actionFirst(overview.data.cards)[0] : undefined
  if (!repo && first)
    return <Navigate to="/releases/compare" search={{ repo: repoKey(first.repo) }} replace />

  const range = refs.data ? defaultRange(refs.data, asked) : asked
  const searchOf = (next: CompareRange) => ({
    ...(repo ? { repo: repoKey(repo) } : {}),
    ...(next.from !== undefined ? { from: next.from } : {}),
    ...(next.to !== undefined ? { to: next.to } : {}),
  })
  if (repo && !sameRange(asked, range))
    return <Navigate to="/releases/compare" search={searchOf(range)} replace />
  const onRange = (next: CompareRange) =>
    void navigate({ to: '/releases/compare', search: searchOf(next), replace: true })

  return (
    <Page
      crumbs={[
        { label: 'Compare', link: { to: '/releases/compare' } },
        ...(repo ? [{ label: repo.path }] : []),
      ]}
      actions={<ReleaseRepoSwitch repo={repo} to="/releases/compare" />}
    >
      {!repo ? (
        <EmptyState
          title="No repository"
          description={
            <>
              Pick one above or open it from the <Link to="/releases">Overview</Link>.
            </>
          }
        />
      ) : refs.isPending ? (
        <Placeholder className="h-16" />
      ) : (
        <>
          {refs.isError ? (
            <Notice tone="warning" title="Versions not listed">
              {messageOf(refs.error)}
            </Notice>
          ) : null}
          <Body repo={repo} refs={refs.data} range={range} onRange={onRange} />
        </>
      )}
    </Page>
  )
}
