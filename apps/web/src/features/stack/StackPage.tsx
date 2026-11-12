import type { GroupMatch, RepoRef, StackComponentKind, StackGroupView } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Bot, FileCheck2, GitPullRequest, Layers } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useApplyChanges,
  useStack,
  useTaskGroupMutations,
  useWriteTasks,
} from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDate, formatRelative, plural } from '../../lib/format.ts'
import type { ScopeView } from '../../lib/home-scope.ts'
import { parseRepoKey, repoKey, repoSplat, splitRepoPath } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import {
  type ConventionGrid,
  type ConventionRow,
  type MatrixCell,
  type MatrixRow,
  type MatrixTool,
  type PlacedConvention,
  type StackPane,
  type StackSearch,
  type StackSegment,
  type StackSheetItem,
  type StackTab,
  type ToolRow,
  type VersionCell,
  cellStatus,
  conventionGrid,
  conventionItems,
  conventionKey,
  conventionLabel,
  conventionTone,
  lineKey,
  matchingConvention,
  matrixCounts,
  monthYear,
  narrowStack,
  parseLineKey,
  parseStackTab,
  repoMatrix,
  scopeStack,
  sheetItems,
  sheetKey,
  suggestedSteps,
  supportLabel,
  supportLegend,
  supportTone,
  versionLines,
  weeklyChanges,
} from '../../lib/stack.ts'
import { taskGroupCap } from '../../lib/tasks.ts'
import {
  ConfirmDialog,
  Count,
  Dot,
  EmptyState,
  ErrorState,
  FilterButton,
  type FleetColumn,
  FleetTable,
  KeyValue,
  Page,
  Placeholder,
  Segmented,
  SegmentedTabs,
  SideSheet,
  type StripCell,
  Table,
  Tag,
  Td,
  Th,
  notify,
  quietActionsOf,
} from '../../ui/index.ts'
import { RunJobButton, useRunJob } from '../jobs/RunJobDialog.tsx'
import { FileDiffView } from '../reports/blocks/DiffView.tsx'
import { SettingsButton, useConfigure } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'

/** What the Stack view keeps besides its tab: filters and the open version line. */
type StackState = Omit<StackSearch, 'tab'>

const kindLabels: Record<StackComponentKind, string> = {
  runtime: 'Runtimes',
  'package-manager': 'Package managers',
  service: 'Services',
  os: 'Base systems',
  image: 'Images',
  tool: 'Tools',
}

const withoutSheet = ({ line: _line, repo: _repo, pane: _pane, ...rest }: StackState) => rest

/**
 * The stack of the readable repositories: a repository × tool matrix with a support segment, the
 * version lines in use, and each group's conventions. `group` limits it to one config group, as
 * the group page shows it. Filters and the open line live in `search` when the caller keeps them
 * (the Stack page keeps them in the URL), else in local state.
 */
export function StackView({
  group,
  tab,
  onTab,
  search,
  onSearch,
}: {
  group?: string
  tab: StackTab
  onTab: (tab: StackTab) => void
  search?: StackState
  onSearch?: (next: StackState) => void
}) {
  const stack = useStack()
  const { view, setView, homeGroups } = useScope()
  const [local, setLocal] = useState<StackState>({})
  const state = search ?? local
  const setState = onSearch ?? setLocal

  if (stack.isPending) return <Placeholder className="h-96" />
  if (stack.isError) return <ErrorState error={stack.error} />
  const picked = group
    ? stack.data.groups.filter((entry) => entry.group === group)
    : stack.data.groups
  if (!picked.length)
    return (
      <EmptyState
        icon={<Layers />}
        title="No stack yet"
        description="The stack analysis reads each group's version files, images and CI through the forge. Run it once; it then stays fresh on its own."
        action={
          <RunJobButton analyzer="stack" label="Run now" size="sm" {...(group ? { group } : {})} />
        }
      />
    )

  const configGroups = [
    ...new Set(picked.flatMap((entry) => entry.repos.flatMap((repo) => repo.groups))),
  ].toSorted()
  const kinds = [...new Set(picked.flatMap((entry) => entry.tools.map((tool) => tool.kind)))]
  const filtered = narrowStack(picked, {
    ...(state.kind ? { kind: state.kind } : {}),
    ...(state.group ? { group: state.group } : {}),
  })
  const scoped = scopeStack(filtered, group ? 'all' : view, homeGroups)
  const grid = conventionGrid(filtered)
  const failing = grid.counts.drifts + grid.counts.missing

  const filters = (
    <>
      {kinds.length > 1 ? (
        <FilterButton
          label="Kind"
          options={Object.entries(kindLabels)
            .filter(([id]) => kinds.some((kind) => kind === id))
            .map(([id, label]) => ({ id, label }))}
          value={state.kind ?? []}
          onChange={(kind) =>
            setState({
              ...state,
              kind: kind.length ? kinds.filter((entry) => kind.includes(entry)) : undefined,
            })
          }
        />
      ) : null}
      {!group && configGroups.length > 1 ? (
        <FilterButton
          label="Group"
          options={configGroups.map((id) => ({ id, label: id }))}
          value={state.group ?? []}
          onChange={(next) => setState({ ...state, group: next.length ? next : undefined })}
        />
      ) : null}
    </>
  )

  return (
    <div className="flex flex-col gap-4">
      <SegmentedTabs
        aria-label="Stack views"
        items={[
          { id: 'runtimes', label: 'Runtimes', icon: Layers },
          {
            id: 'conventions',
            label: (
              <span className="inline-flex items-center gap-1.5">
                Conventions
                {failing ? <Count label="drifting or missing">{failing}</Count> : null}
              </span>
            ),
            icon: FileCheck2,
          },
        ]}
        selected={tab}
        onSelect={(id) => onTab(parseStackTab(id))}
        className="self-start"
      />
      {tab === 'conventions' ? (
        <Conventions
          grid={grid}
          scope={group ? undefined : { value: view, onChange: setView, homeGroups }}
          toolbar={filters}
        />
      ) : (
        <Runtimes
          groups={filtered}
          scopedGroups={scoped.groups}
          state={state}
          setState={setState}
          scope={group ? undefined : { value: view, onChange: setView, homeGroups }}
          toolbar={filters}
          conventions={grid}
          onConventions={() => onTab('conventions')}
        />
      )}
    </div>
  )
}

type Scope =
  | { value: ScopeView; onChange: (view: ScopeView) => void; homeGroups: readonly GroupMatch[] }
  | undefined

const segmentLabel = (label: string, count: number) => (
  <span className="inline-flex items-center gap-1.5">
    {label}
    {count ? <span className="tabular text-muted">{count}</span> : null}
  </span>
)

function Runtimes({
  groups,
  scopedGroups,
  state,
  setState,
  scope,
  toolbar,
  conventions,
  onConventions,
}: {
  groups: StackGroupView[]
  scopedGroups: StackGroupView[]
  state: StackState
  setState: (next: StackState) => void
  scope: Scope
  toolbar: ReactNode
  conventions: ConventionGrid
  onConventions: () => void
}) {
  const everything = repoMatrix(groups)
  const totals = matrixCounts(everything)
  const matrix = state.segment ? repoMatrix(groups, state.segment) : everything
  const lines = versionLines(scopedGroups)
  const allLines = versionLines(groups)
  const changes = weeklyChanges(scopedGroups)
  const checkedAt = groups.map((entry) => entry.checkedAt).toSorted()[0]
  const soonDays = groups[0]?.soonDays ?? 180

  const open = (item: StackSheetItem, pane?: StackPane) =>
    setState({
      ...withoutSheet(state),
      line: item.line,
      ...(item.repo ? { repo: item.repo } : {}),
      ...(pane ? { pane } : {}),
    })
  const opened: StackSheetItem | undefined = state.line
    ? { line: state.line, ...(state.repo ? { repo: state.repo } : {}) }
    : undefined
  const items = sheetItems(repoMatrix(scopedGroups, state.segment), lines, Boolean(state.repo))
  const step = neighbours(items.map(sheetKey), opened ? sheetKey(opened) : undefined)

  const strip = (shown: readonly MatrixRow[]): StripCell[] => {
    const counts = matrixCounts({ tools: matrix.tools, rows: [...shown] })
    const tools = new Set(shown.flatMap((row) => Object.keys(row.cells))).size
    return [
      {
        value: tools,
        label: `${tools === 1 ? 'tool' : 'tools'} in ${plural(counts.repos, 'repository', 'repositories')}`,
      },
      {
        value: counts.eol,
        tone: counts.eol ? 'danger' : 'none',
        label: `${counts.eol === 1 ? 'cell' : 'cells'} end of life`,
        caption: counts.eol
          ? `in ${plural(counts.eolRepos, 'repository', 'repositories')}`
          : undefined,
      },
      {
        value: counts.eolSoon,
        tone: counts.eolSoon ? 'warning' : 'none',
        label: `end within ${soonDays} days`,
      },
      ...(changes
        ? [
            {
              prefix: `Since ${formatDate(changes.since)}:`,
              value: changes.newEol,
              label: `new and ${changes.resolvedEol} resolved end-of-life lines`,
            },
          ]
        : []),
      {
        prefix: 'Conventions',
        value: conventions.counts.matches,
        label: `match · ${conventions.counts.drifts} drift · ${conventions.counts.missing} missing`,
        caption: (
          <button type="button" onClick={onConventions} className="text-foreground hover:underline">
            Open
          </button>
        ),
        end: true,
      },
    ]
  }

  const columns: FleetColumn<MatrixRow>[] = [
    {
      id: 'repo',
      header: 'Repository',
      className: 'min-w-56',
      cell: (row) => <RepoCell row={row} />,
    },
    ...matrix.tools.map((tool): FleetColumn<MatrixRow> => ({
      id: tool.id,
      header: <ToolHeader tool={tool} />,
      cell: (row) => {
        const cell = row.cells[tool.id]
        if (!cell)
          return (
            <span className="text-dim" aria-label={`${tool.name} not used in ${row.repo}`}>
              —
            </span>
          )
        return (
          <CellButton
            tool={tool}
            row={row}
            cell={cell}
            selected={state.repo === row.key && state.line === lineKey(tool.id, cell.line)}
            onOpen={() => open({ line: lineKey(tool.id, cell.line), repo: row.key })}
          />
        )
      },
    })),
  ]

  return (
    <div className="flex flex-col gap-4">
      <FleetTable<MatrixRow>
        label="Repositories and tools"
        rows={matrix.rows}
        rowKey={(row) => row.key}
        columns={columns}
        {...(scope ? { scope } : {})}
        strip={strip}
        legend={supportLegend.map((item) => ({
          tone: item.tone,
          label: item.tone === 'warning' ? `Ends within ${soonDays} days` : item.label,
        }))}
        toolbar={
          <>
            <Segmented<'all' | StackSegment>
              aria-label="Support"
              value={state.segment ?? 'all'}
              onChange={(segment) =>
                setState({
                  ...withoutSheet(state),
                  segment: segment === 'all' ? undefined : segment,
                })
              }
              options={[
                { id: 'all', label: 'All' },
                { id: 'eol-soon', label: segmentLabel('Ends soon', totals.eolSoon) },
                { id: 'eol', label: segmentLabel('End of life', totals.eol) },
              ]}
            />
            {toolbar}
          </>
        }
        othersSummary={(others) => {
          const counts = matrixCounts({ tools: matrix.tools, rows: [...others] })
          return `${counts.eol} end of life, ${counts.eolSoon} ending soon`
        }}
        caption={checkedAt ? `· lifecycle dates checked ${formatRelative(checkedAt)}` : undefined}
        empty={
          <EmptyState
            icon={<Layers />}
            title={state.segment ? 'Nothing in this segment' : 'No runtimes or images found'}
            {...(state.segment
              ? { description: 'No repository uses a release line that has ended or ends soon.' }
              : {})}
          />
        }
      />
      <VersionLines lines={lines} opened={opened} onOpen={(item) => open(item, 'where')} />
      <LineSheet
        groups={groups}
        lines={allLines}
        item={opened}
        pane={state.pane ?? (state.repo ? 'cell' : 'where')}
        onPane={(pane) => setState({ ...state, pane })}
        index={step.index}
        total={items.length}
        onClose={() => setState(withoutSheet(state))}
        {...(step.previous ? { onPrevious: () => open(items[step.index - 1]!, state.pane) } : {})}
        {...(step.next ? { onNext: () => open(items[step.index + 1]!, state.pane) } : {})}
      />
    </div>
  )
}

function RepoLink({ forge, path }: { forge: string; path: string }) {
  const { namespace, name } = splitRepoPath(path)
  return (
    <Link
      to="/repos/$"
      params={{ _splat: repoSplat({ forge, path }) }}
      search={{ tab: 'supply', section: 'stack' }}
      className="mono min-w-0 truncate text-[12.5px] hover:underline"
      title={path}
    >
      <span className="text-muted">{namespace}</span>
      <span className="font-medium">{name}</span>
    </Link>
  )
}

function RepoCell({ row }: { row: MatrixRow }) {
  return (
    <div className="flex min-w-0 flex-col">
      <RepoLink forge={row.forge} path={row.repo} />
      <span className="truncate text-[11px] text-dim">
        {row.error ? `Not read: ${row.error}` : row.groups.join(', ')}
      </span>
    </div>
  )
}

function ToolHeader({ tool }: { tool: MatrixTool }) {
  return (
    <span className="flex flex-col">
      <span className="text-[12.5px] text-foreground">{tool.name}</span>
      <span className="mono text-[11px] font-normal text-dim">
        {tool.latest ? `latest ${tool.latest}` : kindLabels[tool.kind].toLowerCase()}
      </span>
    </span>
  )
}

function CellButton({
  tool,
  row,
  cell,
  selected,
  onOpen,
}: {
  tool: MatrixTool
  row: MatrixRow
  cell: MatrixCell
  selected: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      aria-label={`${tool.name} ${cell.version} in ${row.repo}: ${cell.status.label}`}
      className={`flex flex-col items-start rounded-md px-1.5 py-1 text-left hover:bg-raise ${selected ? 'bg-raise shadow-[inset_0_0_0_1px_var(--color-line-strong)]' : ''}`}
    >
      <span className="mono text-[12.5px]">{cell.version}</span>
      <span className="inline-flex items-center gap-1 text-[11px] text-muted">
        <Dot tone={cell.status.tone} />
        {cell.status.label}
      </span>
    </button>
  )
}

function VersionLines({
  lines,
  opened,
  onOpen,
}: {
  lines: ToolRow[]
  opened: StackSheetItem | undefined
  onOpen: (item: StackSheetItem) => void
}) {
  if (!lines.length) return null
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex flex-col gap-0.5 px-3.5 pt-3 pb-2">
        <h2 className="text-[13px] font-semibold">Version lines</h2>
        <p className="text-xs text-muted">
          Each line in use, with its support status and how many repositories run it
        </p>
      </div>
      <Table label="Version lines">
        <thead>
          <tr>
            <Th>Tool</Th>
            <Th>Kind</Th>
            <Th>Latest</Th>
            <Th>Lines in use</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((tool) => (
            <tr key={tool.id}>
              <Td className="max-w-[16rem]">
                <span className="truncate font-medium" title={tool.id}>
                  {tool.name}
                </span>
              </Td>
              <Td className="text-muted">{kindLabels[tool.kind].toLowerCase()}</Td>
              <Td className="mono">
                {tool.latest ?? '—'}
                {tool.latestLts && tool.latestLts !== tool.latest ? (
                  <span className="text-muted"> · LTS {tool.latestLts}</span>
                ) : null}
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1.5">
                  {tool.versions.map((cell) => {
                    const status = lineStatus(cell)
                    const key = lineKey(tool.id, cell.version)
                    const on = opened?.line === key && !opened.repo
                    return (
                      <button
                        key={cell.version}
                        type="button"
                        onClick={() => onOpen({ line: key })}
                        aria-pressed={on}
                        aria-label={`${tool.name} ${cell.version}, ${status.label}, ${plural(cell.repos.length, 'repository', 'repositories')}`}
                        className={`inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-raise ${on ? 'bg-raise' : ''}`}
                      >
                        <Dot tone={status.tone} />
                        <span className="mono">{cell.version}</span>
                        <span className="text-muted">{status.label}</span>
                        <span className="tabular text-muted">
                          {plural(cell.repos.length, 'repo')}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  )
}

const lineStatus = (cell: Pick<VersionCell, 'support' | 'eolDate'>) =>
  cellStatus({
    support: cell.support,
    lag: 'unknown',
    ...(cell.eolDate ? { eolDate: cell.eolDate } : {}),
  })

/** "Open merge request" for a convention with a suggested fix, when the viewer may run analyses. */
function useMergeRequestAction(result: PlacedConvention | undefined) {
  const { can } = useSession()
  const apply = useApplyChanges(result?.analysisId ?? '')
  const changeId = result?.diff?.length && can('analyses:run') ? result.changeId : undefined
  if (!changeId) return undefined
  return {
    label: apply.isPending ? 'Opening…' : 'Open merge request',
    icon: GitPullRequest,
    onPress: () => {
      if (apply.isPending) return
      apply.mutate(
        { ids: [changeId], mode: 'merge-request' },
        {
          onSuccess: (outcome) => {
            if (outcome.conflicts.length)
              notify.error('The fix no longer applies', 'Run the stack scan again.')
            if (outcome.mergeRequest) {
              const url = outcome.mergeRequest.url
              notify.success(
                `Merge request !${outcome.mergeRequest.id} opened`,
                <a href={url} target="_blank" rel="noreferrer" className="underline">
                  {url}
                </a>,
              )
            }
          },
          onError: (error) => notify.error('Merge request not opened', messageOf(error)),
        },
      )
    },
  }
}

/**
 * One version line: its support, where it is declared, and, with a matrix cell picked, that
 * repository's versions, the suggested upgrade steps and the convention its file is checked
 * against.
 */
function LineSheet({
  groups,
  lines,
  item,
  pane,
  onPane,
  index,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  groups: readonly StackGroupView[]
  lines: readonly ToolRow[]
  item: StackSheetItem | undefined
  pane: StackPane
  onPane: (pane: StackPane) => void
  index: number
  total: number
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
}) {
  const parsed = parseLineKey(item?.line)
  const tool = parsed ? lines.find((entry) => entry.id === parsed.toolId) : undefined
  const cell = tool?.versions.find((entry) => entry.version === parsed?.line)
  const repoUses = item?.repo ? (cell?.uses.filter((use) => use.key === item.repo) ?? []) : []
  const convention =
    item?.repo && repoUses.length
      ? matchingConvention(
          groups,
          item.repo,
          repoUses.map((use) => use.file),
        )
      : undefined
  const mergeRequest = useMergeRequestAction(convention)
  const { can } = useSession()
  const [planning, setPlanning] = useState(false)
  const open = Boolean(tool && cell)
  const shownPane = repoUses.length ? pane : 'where'
  const status = cell ? lineStatus(cell) : undefined
  const cycle = tool?.cycles?.find((entry) => entry.cycle === cell?.version)
  const step =
    tool && cell
      ? suggestedSteps(tool, cell.version, new Date(), groups[0]?.soonDays ?? 180)[0]
      : undefined
  const quiet = quietActionsOf([
    ...(step && can('tasks:run')
      ? [{ label: 'Plan upgrade with agent', icon: Bot, onPress: () => setPlanning(true) }]
      : []),
    ...(mergeRequest ? [mergeRequest] : []),
  ])
  return (
    <SideSheet
      open={open}
      onClose={onClose}
      id={tool && cell ? `${tool.id} · ${cell.version}` : undefined}
      title={tool && cell ? `${tool.name} ${cell.version}` : ''}
      {...(open ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
      {...(quiet && { quietActions: quiet })}
      {...(tool && cell
        ? {
            tabs: {
              'aria-label': 'Version line views',
              selected: shownPane,
              onSelect: (id: string) => onPane(id === 'cell' ? 'cell' : 'where'),
              items: [
                {
                  id: 'where',
                  label: 'Where declared',
                  badge: <Count>{cell.uses.length}</Count>,
                },
                ...(repoUses.length ? [{ id: 'cell', label: 'Selected cell' }] : []),
              ],
            },
          }
        : {})}
    >
      {tool && cell && status ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <Tag tone={status.tone} dot>
              {status.label}
            </Tag>
            {cell.eolDate ? (
              <span className="text-muted">
                {cell.support === 'eol' ? 'ended' : 'ends'} {formatDate(cell.eolDate)}
              </span>
            ) : null}
            <span className="text-muted">
              {tool.latest ? `Latest ${tool.latest}` : null}
              {tool.latestLts && tool.latestLts !== tool.latest ? ` · LTS ${tool.latestLts}` : ''}
              {` · ${kindLabels[tool.kind].toLowerCase()}`}
            </span>
          </div>
          {shownPane === 'cell' && item?.repo ? (
            <SelectedCell
              repo={item.repo}
              tool={tool}
              line={cell.version}
              uses={repoUses}
              convention={convention}
              soonDays={groups[0]?.soonDays ?? 180}
            />
          ) : (
            <Table label={`Where ${tool.name} ${cell.version} is declared`}>
              <thead>
                <tr>
                  <Th>Repository</Th>
                  <Th>Written</Th>
                  <Th>File</Th>
                </tr>
              </thead>
              <tbody>
                {cell.uses.map((use) => (
                  <tr key={`${use.key}\0${use.file}\0${use.declared}`}>
                    <Td>
                      <UseRepoLink repoKey={use.key} />
                    </Td>
                    <Td className="mono">{use.image ?? use.declared}</Td>
                    <Td className="mono text-xs text-muted">{use.file}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <section className="flex flex-col gap-2.5 border-t border-line pt-3.5">
            <h3 className="text-[11.5px] font-medium text-muted">Line</h3>
            <KeyValue
              rows={[
                {
                  label: 'Released',
                  value: cycle?.releaseDate ? formatDate(cycle.releaseDate) : undefined,
                },
                {
                  label: 'End of life',
                  value: cell.eolDate
                    ? `${formatDate(cell.eolDate)} · ${formatRelative(cell.eolDate)}`
                    : cycle?.eol === false
                      ? 'None planned'
                      : undefined,
                },
                {
                  label: 'Newest release',
                  value: cycle?.latest ? <span className="mono">{cycle.latest}</span> : undefined,
                },
                {
                  label: 'Repositories',
                  value: plural(cell.repos.length, 'repository', 'repositories'),
                },
              ]}
            />
          </section>
        </div>
      ) : null}
      {planning && tool && cell && step ? (
        <PlanUpgradeDialog
          tool={tool.name}
          line={cell.version}
          to={step.version}
          repos={cell.repos}
          onClose={() => setPlanning(false)}
        />
      ) : null}
    </SideSheet>
  )
}

function UseRepoLink({ repoKey: key }: { repoKey: string }) {
  const ref = parseRepoKey(key)
  return ref ? <RepoLink forge={ref.forge} path={ref.path} /> : <span className="mono">{key}</span>
}

/**
 * Starts an `upgrade` task group that moves every repository on `line` of `tool` to `to`, one
 * draft merge request per repository; says when write tasks are off or the group is too big.
 */
function PlanUpgradeDialog({
  tool,
  line,
  to,
  repos,
  onClose,
}: {
  tool: string
  line: string
  to: string
  repos: readonly string[]
  onClose: () => void
}) {
  const tasks = useTaskGroupMutations()
  const write = useWriteTasks()
  const cap = write.data ? taskGroupCap(write.data, repos.length) : undefined
  const tooMany = write.data !== undefined && repos.length > write.data.maxRepos
  const reason = write.isError
    ? 'Could not check whether write tasks are on.'
    : write.data && !write.data.enabled
      ? 'Write tasks are turned off; an admin turns them on in Ops › Tasks.'
      : tooMany
        ? `One task changes at most ${write.data?.maxRepos} repositories.`
        : undefined
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={`Upgrade ${tool} ${line} to ${to}?`}
      confirmLabel={`Start in ${plural(repos.length, 'repo')}`}
      isPending={tasks.create.isPending}
      isDisabled={!write.data || reason !== undefined}
      onConfirm={() =>
        tasks.create.mutate(
          {
            kind: 'upgrade',
            title: `Upgrade ${tool} ${line} to ${to}`,
            prompt: `Move ${tool} from the ${line} line to ${to} in this repository: update every place that declares the version (version files, images, CI, engines), adjust code and configuration the new version needs, and keep the change minimal.`,
            repos: [...repos],
            run: true,
          },
          {
            onSuccess: (created) => {
              onClose()
              notify.success(`Queued ${plural(created.tasks.length, 'task')}`)
            },
            onError: (error) => notify.error('Not started', messageOf(error)),
          },
        )
      }
    >
      {reason ? <p className="mb-2 text-sm text-warn">{reason}</p> : null}
      <p>
        An agent opens a draft merge request in each repository on {tool} {line}. Nothing is merged.
      </p>
      {cap ? (
        <p className="mt-2 text-sm">
          Spend cap <span className="mono">${cap.total.toFixed(2)}</span>
          <span className="text-muted">
            {' '}
            (<span className="mono">${cap.perRepo.toFixed(2)}</span> per repository)
          </span>
        </p>
      ) : null}
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {repos.map((repo) => (
          <li key={repo}>
            <Tag mono>{repo}</Tag>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  )
}

function SelectedCell({
  repo,
  tool,
  line,
  uses,
  convention,
  soonDays,
}: {
  repo: string
  tool: ToolRow
  line: string
  uses: VersionCell['uses']
  convention: PlacedConvention | undefined
  soonDays: number
}) {
  const shown = uses[0]!
  const image = uses.find((use) => use.image)
  const steps = suggestedSteps(tool, line, new Date(), soonDays)
  const suggested = steps.find((step) => step.kind === 'suggested')
  const smaller = steps.find((step) => step.kind === 'smaller')
  const status = cellStatus(shown)
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2.5">
        <h3 className="text-[11.5px] font-medium text-muted">
          Selected cell · <span className="mono">{repo.slice(repo.indexOf(':') + 1)}</span>
        </h3>
        <KeyValue
          rows={[
            {
              label: 'In use',
              value: (
                <>
                  <span className="mono">{shown.version ?? shown.declared}</span>
                  <Tag tone={status.tone} dot>
                    {status.label}
                  </Tag>
                </>
              ),
            },
            {
              label: 'Image',
              value: image?.image ? (
                <>
                  <span className="mono">{image.image}</span>
                  <span className="text-muted">same line</span>
                </>
              ) : undefined,
            },
            {
              label: 'Suggested',
              value: suggested ? (
                <>
                  <span className="mono">{suggested.version}</span>
                  <Tag tone={supportTone(suggested.support)}>{supportLabel[suggested.support]}</Tag>
                </>
              ) : undefined,
            },
            {
              label: 'Smaller step',
              value: smaller ? (
                <>
                  <span className="mono">{smaller.version}</span>
                  {smaller.eolDate ? (
                    <span className="text-muted">ends {monthYear(smaller.eolDate)}</span>
                  ) : null}
                </>
              ) : undefined,
            },
            {
              label: 'Convention',
              value: convention ? (
                <>
                  <Tag tone={conventionTone(convention.status)} dot>
                    {conventionLabel[convention.status]}
                  </Tag>
                  <span className="mono text-muted">{convention.file}</span>
                  <span className="text-muted">{convention.group}</span>
                </>
              ) : undefined,
            },
          ]}
        />
      </section>
      {convention && convention.status !== 'matches' ? (
        <section className="flex flex-col gap-2.5 border-t border-line pt-3.5">
          <h3 className="text-[11.5px] font-medium text-muted">
            Convention · <span className="mono">{convention.file}</span>
          </h3>
          <ConventionDetail result={convention} />
        </section>
      ) : null}
    </div>
  )
}

function Conventions({
  grid,
  scope,
  toolbar,
}: {
  grid: ConventionGrid
  scope: Scope
  toolbar: ReactNode
}) {
  const [openKey, setOpenKey] = useState<string>()
  const edit = (
    <SettingsButton title="Stack settings" keys={pageSettingKeys.stack} label="Edit conventions" />
  )
  const items = conventionItems(grid)
  const step = neighbours(items.map(conventionKey), openKey)
  const opened = step.index >= 0 ? items[step.index] : undefined
  if (!grid.rows.length)
    return (
      <EmptyState
        icon={<FileCheck2 />}
        title="No conventions yet"
        description="Conventions are golden files every repository of a group should match: a path, a match mode and the content. Add them to the Tech stack analyzer settings of a group."
        action={edit}
      />
    )
  const columns: FleetColumn<ConventionRow>[] = [
    {
      id: 'repo',
      header: 'Repository',
      className: 'min-w-56',
      cell: (row) => {
        const ref = parseRepoKey(row.key)
        return ref ? (
          <RepoLink forge={ref.forge} path={ref.path} />
        ) : (
          <span className="mono text-[12.5px]">{row.repo}</span>
        )
      },
    },
    ...grid.files.map((file): FleetColumn<ConventionRow> => ({
      id: file,
      header: <span className="mono">{file}</span>,
      cell: (row) => {
        const cell = row.cells[file]
        if (!cell) return <span className="text-dim">—</span>
        return (
          <button
            type="button"
            onClick={() => setOpenKey(conventionKey(cell))}
            aria-pressed={openKey === conventionKey(cell)}
            className="rounded-md hover:bg-raise"
            aria-label={`${file} in ${row.repo}: ${conventionLabel[cell.status]}`}
          >
            <Tag tone={conventionTone(cell.status)} dot>
              {conventionLabel[cell.status]}
            </Tag>
          </button>
        )
      },
    })),
  ]
  return (
    <>
      <FleetTable<ConventionRow>
        label="Conventions"
        rows={grid.rows}
        rowKey={(row) => row.key}
        columns={columns}
        {...(scope ? { scope } : {})}
        strip={(shown) => {
          const cells = shown.flatMap((row) => Object.values(row.cells))
          const count = (status: PlacedConvention['status']) =>
            cells.filter((cell) => cell?.status === status).length
          return [
            { value: count('matches'), tone: 'success', label: 'match' },
            { value: count('drifts'), tone: 'warning', label: 'drift' },
            { value: count('missing'), tone: 'danger', label: 'missing' },
            ...(count('error') ? [{ value: count('error'), label: 'not compared' }] : []),
          ]
        }}
        toolbar={
          <>
            {toolbar}
            <span className="ml-auto">{edit}</span>
          </>
        }
      />
      <ConventionSheet
        result={opened}
        index={step.index}
        total={items.length}
        onClose={() => setOpenKey(undefined)}
        {...(step.previous ? { onPrevious: () => setOpenKey(step.previous) } : {})}
        {...(step.next ? { onNext: () => setOpenKey(step.next) } : {})}
      />
    </>
  )
}

function ConventionSheet({
  result,
  index,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  result: PlacedConvention | undefined
  index: number
  total: number
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
}) {
  const mergeRequest = useMergeRequestAction(result)
  return (
    <SideSheet
      open={result !== undefined}
      onClose={onClose}
      id={result?.file}
      title={result?.repo ?? ''}
      {...(result ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
      {...(mergeRequest ? { quietActions: [mergeRequest] as const } : {})}
    >
      {result ? <ConventionDetail result={result} /> : null}
    </SideSheet>
  )
}

function ConventionDetail({ result }: { result: PlacedConvention }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={conventionTone(result.status)} dot>
          {conventionLabel[result.status]}
        </Tag>
        <Tag mono>{result.mode}</Tag>
        <span className="text-xs text-muted">group {result.group}</span>
      </div>
      {result.problems.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {result.problems.map((problem) => (
            <li key={problem} className="mono text-[12.5px]">
              {problem}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-muted">The file matches the convention.</p>
      )}
      {result.diff?.length ? (
        <div className="flex flex-col gap-2">
          <span className="text-[12.5px] font-medium">Suggested fix</span>
          {result.diff.map((file) => (
            <FileDiffView
              key={file.file}
              file={file}
              mode="unified"
              formatted={false}
              defaultOpen
            />
          ))}
          <p className="text-xs text-muted">
            Before opening, the fix is checked against the current branch; if it no longer applies,
            run the stack scan again.
          </p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The stack of one repository for its hub: each tool it uses with the version, support and the
 * suggested step, and the conventions it is checked against. A tool opens its version line sheet
 * with this repository's cell selected.
 */
export function RepoStack({ repo }: { repo: RepoRef }) {
  const stack = useStack()
  const [state, setState] = useState<StackState>({})
  if (stack.isPending) return <Placeholder className="h-48" />
  if (stack.isError) return <ErrorState error={stack.error} />
  const key = repoKey(repo)
  const groups = narrowStack(stack.data.groups, { repo: key })
  const matrix = repoMatrix(groups)
  const row = matrix.rows[0]
  const lines = versionLines(groups)
  const grid = conventionGrid(groups)
  const conventions = grid.rows[0]
  if (!row || !Object.keys(row.cells).length)
    return (
      <EmptyState
        icon={<Layers />}
        title="No stack for this repository"
        description="The stack analysis of its group has not found runtimes, images or tools here yet."
        action={<RunJobButton analyzer="stack" label="Run stack scan" size="sm" repo={repo} />}
      />
    )
  const now = new Date()
  const soonDays = groups[0]?.soonDays ?? 180
  const items = sheetItems(matrix, lines, true)
  const opened: StackSheetItem | undefined = state.line
    ? { line: state.line, repo: key }
    : undefined
  const step = neighbours(items.map(sheetKey), opened ? sheetKey(opened) : undefined)
  const open = (item: StackSheetItem) => setState({ line: item.line, pane: state.pane })
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-line bg-panel">
        <Table label="Runtimes and tools">
          <thead>
            <tr>
              <Th>Tool</Th>
              <Th>In use</Th>
              <Th>Support</Th>
              <Th>Declared in</Th>
              <Th>Suggested</Th>
            </tr>
          </thead>
          <tbody>
            {matrix.tools.map((tool) => {
              const cell = row.cells[tool.id]
              if (!cell) return null
              const line = lines.find((entry) => entry.id === tool.id)
              const suggested = line ? suggestedSteps(line, cell.line, now, soonDays)[0] : undefined
              return (
                <tr key={tool.id}>
                  <Td>
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => open({ line: lineKey(tool.id, cell.line), repo: key })}
                    >
                      {tool.name}
                    </button>
                  </Td>
                  <Td className="mono">{cell.version}</Td>
                  <Td>
                    <Tag tone={cell.status.tone} dot>
                      {cell.status.label}
                    </Tag>
                  </Td>
                  <Td className="mono text-xs text-muted">
                    {[...new Set(cell.uses.map((use) => use.file))].join(', ')}
                  </Td>
                  <Td className="mono">{suggested?.version ?? '—'}</Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
        {conventions ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5 text-xs text-muted">
            <span>Conventions</span>
            {grid.files.map((file) => {
              const result = conventions.cells[file]
              return result ? (
                <Tag key={file} tone={conventionTone(result.status)} dot>
                  <span className="mono">{file}</span> {conventionLabel[result.status]}
                </Tag>
              ) : null
            })}
          </div>
        ) : null}
      </section>
      <LineSheet
        groups={groups}
        lines={lines}
        item={opened}
        pane={state.pane ?? 'cell'}
        onPane={(pane) => setState({ ...state, pane })}
        index={step.index}
        total={items.length}
        onClose={() => setState({})}
        {...(step.previous ? { onPrevious: () => open(items[step.index - 1]!) } : {})}
        {...(step.next ? { onNext: () => open(items[step.index + 1]!) } : {})}
      />
    </div>
  )
}

/** The Stack page: the repository × tool matrix, version lines and conventions across the readable groups. */
export function StackPage() {
  const search = useSearch({ from: '/app/supply/stack' })
  const navigate = useNavigate()
  const tab = parseStackTab(search.tab)
  const { configure, sheet } = useConfigure('Stack settings', pageSettingKeys.stack)
  const run = useRunJob({ analyzer: 'stack', label: 'Run stack scan' })
  const { tab: _tab, ...state } = search
  return (
    <Page
      crumbs={[{ label: 'Stack' }]}
      description="Runtimes, images and tools per repository and version line, their support, and how repositories match their group's conventions"
      {...(configure ? { configure } : {})}
      primary={run.action}
    >
      <StackView
        tab={tab}
        onTab={(next) =>
          void navigate({
            to: '/supply/stack',
            search: { ...withoutSheet(state), ...(next === 'runtimes' ? {} : { tab: next }) },
            replace: true,
          })
        }
        search={state}
        onSearch={(next) =>
          void navigate({
            to: '/supply/stack',
            search: { ...next, ...(tab === 'runtimes' ? {} : { tab }) },
            replace: true,
          })
        }
      />
      {sheet}
      {run.dialog}
    </Page>
  )
}
