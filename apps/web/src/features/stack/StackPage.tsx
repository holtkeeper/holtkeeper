import type { StackGroupView } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { CalendarClock, FileCheck2, GitPullRequest, Layers } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useApplyChanges, useStack } from '../../api/queries.ts'
import { formatDate, formatRelative, plural } from '../../lib/format.ts'
import { pageSettingKeys } from '../../lib/settings-tabs.ts'
import {
  type ConventionGrid,
  type EolEntry,
  type PlacedConvention,
  type StackTab,
  type ToolRow,
  type VersionCell,
  conventionGrid,
  conventionTone,
  eolEntries,
  parseStackTab,
  otherTeamsStack,
  scopeStack,
  supportLabel,
  supportTone,
  toolRows,
  weeklyChanges,
} from '../../lib/stack.ts'
import { statusColor } from '../../ui/colors.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  Page,
  Placeholder,
  OtherTeams,
  ScopeSwitch,
  SegmentedTabs,
  SideSheet,
  Table,
  Tag,
  Td,
  Th,
  notify,
} from '../../ui/index.ts'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { FileDiffView } from '../reports/blocks/DiffView.tsx'
import { SettingsButton } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'

const tabs = [
  { id: 'runtimes', label: 'Runtimes', icon: Layers },
  { id: 'eol', label: 'End of life', icon: CalendarClock },
  { id: 'conventions', label: 'Conventions', icon: FileCheck2 },
] as const

type Opened =
  | { kind: 'cell'; tool: ToolRow; cell: VersionCell }
  | { kind: 'convention'; result: PlacedConvention }

/**
 * The stack of the readable repositories: runtimes, images and tools per version line, the
 * repositories on ended or ending lines, and each group's conventions. `group` limits it to one
 * config group, as the group page shows it.
 */
export function StackView({
  group,
  tab,
  onTab,
}: {
  group?: string
  tab: StackTab
  onTab: (tab: StackTab) => void
}) {
  const stack = useStack()
  const { view, setView, homeGroups } = useScope()
  const [opened, setOpened] = useState<Opened>()

  if (stack.isPending) return <Placeholder className="h-96" />
  if (stack.isError) return <ErrorState error={stack.error} />
  const scoped = scopeStack(stack.data.groups, view, homeGroups, group)
  if (!stack.data.groups.length || (group && !scoped.groups.length))
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

  const changes = weeklyChanges(scoped.groups)
  const rows = toolRows(scoped.groups)
  const eol = eolEntries(scoped.groups)
  const grid = conventionGrid(scoped.groups)
  const counts: Record<StackTab, number> = {
    runtimes: rows.length,
    eol: eol.length,
    conventions: grid.counts.drifts + grid.counts.missing,
  }

  const body = () => {
    if (!group && view === 'others')
      return (
        <p className="text-sm text-muted">
          {plural(scoped.others.repos, 'repository', 'repositories')} of{' '}
          {plural(scoped.others.teams, 'other team')}.{' '}
          <button
            type="button"
            className="text-foreground hover:underline"
            onClick={() => setView('all')}
          >
            Show them
          </button>
        </p>
      )
    const folded =
      !group && view === 'mine' ? otherTeamsStack(stack.data.groups, homeGroups) : undefined
    return (
      <div className="flex flex-col gap-3">
        {tabBody(scoped.groups)}
        {folded ? (
          <OtherTeams count={folded.repos} teams={folded.teams}>
            {tabBody(folded.groups)}
          </OtherTeams>
        ) : null}
      </div>
    )
  }

  const tabBody = (groups: readonly StackGroupView[]) => {
    if (tab === 'eol') return <EolList entries={eolEntries(groups)} />
    if (tab === 'conventions')
      return (
        <Conventions
          grid={conventionGrid(groups)}
          onOpen={(result) => setOpened({ kind: 'convention', result })}
        />
      )
    return (
      <Runtimes
        rows={toolRows(groups)}
        onOpen={(tool, cell) => setOpened({ kind: 'cell', tool, cell })}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs
          aria-label="Stack views"
          items={tabs.map((item) => ({
            ...item,
            label: (
              <span className="inline-flex items-center gap-1.5">
                {item.label}
                {counts[item.id] ? (
                  <span className="tabular text-muted">{counts[item.id]}</span>
                ) : null}
              </span>
            ),
          }))}
          selected={tab}
          onSelect={(id) => onTab(parseStackTab(id))}
        />
        {group ? null : (
          <span className="ml-auto">
            <ScopeSwitch value={view} onChange={setView} counts={scoped.counts} />
          </span>
        )}
      </div>
      {changes ? (
        <p className="text-xs text-muted">
          Since {formatDate(changes.since)}: {changes.newEol} new and {changes.resolvedEol} resolved
          end-of-life lines, {changes.newDrifts} new and {changes.resolvedDrifts} fixed convention
          differences.
        </p>
      ) : null}
      {body()}
      <SideSheet
        open={opened !== undefined}
        onClose={() => setOpened(undefined)}
        id={opened?.kind === 'cell' ? opened.cell.version : opened?.result.file}
        title={opened?.kind === 'cell' ? opened.tool.name : (opened?.result.key ?? '')}
      >
        {opened?.kind === 'cell' ? <CellDetail tool={opened.tool} cell={opened.cell} /> : null}
        {opened?.kind === 'convention' ? (
          <ConventionDetail key={opened.result.key + opened.result.file} result={opened.result} />
        ) : null}
      </SideSheet>
    </div>
  )
}

function Runtimes({
  rows,
  onOpen,
}: {
  rows: ToolRow[]
  onOpen: (tool: ToolRow, cell: VersionCell) => void
}) {
  if (!rows.length) return <EmptyState icon={<Layers />} title="No runtimes or images found" />
  return (
    <div className="rounded-xl border border-line bg-panel">
      <Table label="Runtimes and tools">
        <thead>
          <tr>
            <Th>Tool</Th>
            <Th>Latest</Th>
            <Th>Versions in use</Th>
            <Th align="right">Repos</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <Td className="max-w-[18rem]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-medium" title={row.id}>
                    {row.name}
                  </span>
                  <Tag>{row.kind}</Tag>
                </div>
              </Td>
              <Td className="mono text-[13px]">
                {row.latest ?? '—'}
                {row.latestLts && row.latestLts !== row.latest ? (
                  <span className="text-muted"> · LTS {row.latestLts}</span>
                ) : null}
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1.5">
                  {row.versions.map((cell) => (
                    <button
                      key={cell.version}
                      type="button"
                      onClick={() => onOpen(row, cell)}
                      title={`${supportLabel[cell.support]} · ${plural(cell.repos.length, 'repository', 'repositories')}`}
                      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-raise"
                    >
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full"
                        style={{ background: statusColor[supportTone(cell.support)] }}
                      />
                      <span className="mono">{cell.version}</span>
                      <span className="tabular text-muted">{cell.repos.length}</span>
                    </button>
                  ))}
                </div>
              </Td>
              <Td align="right" className="tabular">
                {row.repos}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}

function CellDetail({ tool, cell }: { tool: ToolRow; cell: VersionCell }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Tag tone={supportTone(cell.support)} dot>
          {supportLabel[cell.support]}
        </Tag>
        {cell.uses[0]?.eolDate ? (
          <span className="text-muted">ends {formatDate(cell.uses[0].eolDate)}</span>
        ) : null}
        {tool.latest ? <span className="text-muted">latest {tool.latest}</span> : null}
      </div>
      <Table label={`Repositories on ${tool.name} ${cell.version}`}>
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
              <Td className="mono text-[13px]">{use.repo}</Td>
              <Td className="mono text-[13px]">{use.image ?? use.declared}</Td>
              <Td className="mono text-xs text-muted">{use.file}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}

function EolList({ entries }: { entries: EolEntry[] }) {
  if (!entries.length)
    return (
      <EmptyState
        icon={<CalendarClock />}
        title="Nothing at end of life"
        description="No repository uses a release line that has ended or ends soon."
      />
    )
  return (
    <div className="rounded-xl border border-line bg-panel">
      <Table label="End of life">
        <thead>
          <tr>
            <Th>Repository</Th>
            <Th>Line</Th>
            <Th>Ends</Th>
            <Th>Fix</Th>
            <Th>Where</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={`${entry.key}\0${entry.toolId}\0${entry.cycle}`}>
              <Td className="mono text-[13px]">{entry.repo}</Td>
              <Td>
                <span className="text-[13px]">
                  {entry.tool} <span className="mono">{entry.cycle}</span>
                </span>
              </Td>
              <Td>
                <Tag tone={supportTone(entry.support)} dot>
                  {entry.eolDate
                    ? entry.support === 'eol'
                      ? `ended ${formatDate(entry.eolDate)}`
                      : formatRelative(entry.eolDate)
                    : supportLabel[entry.support]}
                </Tag>
              </Td>
              <Td className="mono text-[13px]">{entry.fix ?? '—'}</Td>
              <Td className="mono text-xs text-muted">{entry.files.join(', ')}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}

function Conventions({
  grid,
  onOpen,
}: {
  grid: ConventionGrid
  onOpen: (result: PlacedConvention) => void
}) {
  const edit = (
    <SettingsButton title="Stack settings" keys={pageSettingKeys.stack} label="Edit conventions" />
  )
  if (!grid.rows.length)
    return (
      <EmptyState
        icon={<FileCheck2 />}
        title="No conventions yet"
        description="Conventions are golden files every repository of a group should match: a path, a match mode and the content. Add them to the Tech stack analyzer settings of a group."
        action={edit}
      />
    )
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          {grid.counts.matches} match · {grid.counts.drifts} drift · {grid.counts.missing} missing
          {grid.counts.error ? ` · ${grid.counts.error} not compared` : ''}
        </span>
        <span className="ml-auto">{edit}</span>
      </div>
      <div className="rounded-xl border border-line bg-panel">
        <Table label="Conventions">
          <thead>
            <tr>
              <Th>Repository</Th>
              {grid.files.map((file) => (
                <Th key={file}>
                  <span className="mono">{file}</span>
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.key}>
                <Td className="mono text-[13px]">{row.key.slice(row.key.indexOf(':') + 1)}</Td>
                {grid.files.map((file) => {
                  const cell = row.cells[file]
                  return (
                    <Td key={file}>
                      {cell ? (
                        <button
                          type="button"
                          onClick={() => onOpen(cell)}
                          className="rounded-md hover:bg-raise"
                          aria-label={`${file} in ${row.key}: ${cell.status}`}
                        >
                          <Tag tone={conventionTone(cell.status)} dot>
                            {cell.status}
                          </Tag>
                        </button>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  )
}

function ConventionDetail({ result }: { result: PlacedConvention }) {
  const { can } = useSession()
  const apply = useApplyChanges(result.analysisId)
  const open = () => {
    if (!result.changeId) return
    apply.mutate(
      { ids: [result.changeId], mode: 'merge-request' },
      {
        onSuccess: (outcome) => {
          if (outcome.conflicts.length)
            notify.error('The fix no longer applies', 'Run the stack analysis again.')
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
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={conventionTone(result.status)} dot>
          {result.status}
        </Tag>
        <Tag mono>{result.mode}</Tag>
        <span className="text-xs text-muted">{result.group}</span>
      </div>
      {result.problems.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {result.problems.map((problem) => (
            <li key={problem} className="mono text-[13px]">
              {problem}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">The file matches the convention.</p>
      )}
      {result.diff?.length ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Suggested fix</span>
          {result.diff.map((file) => (
            <FileDiffView
              key={file.file}
              file={file}
              mode="unified"
              formatted={false}
              defaultOpen
            />
          ))}
          {result.changeId && can('analyses:run') ? (
            <div>
              <Button size="sm" onPress={open} isPending={apply.isPending}>
                <GitPullRequest className="size-3.5" />
                Open merge request
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

interface StackSearch {
  tab?: string
}

/** The Stack page: runtimes, end of life and conventions across the readable groups. */
export function StackPage() {
  const search: StackSearch = useSearch({ strict: false })
  const navigate = useNavigate()
  const tab = parseStackTab(search.tab)
  return (
    <Page
      title="Stack"
      icon="stack"
      description="Runtimes, images and tools per version line, what reaches end of life and how repositories match their group's conventions"
      actions={
        <>
          <RunJobButton analyzer="stack" label="Run now" variant="secondary" />
          <SettingsButton title="Stack settings" keys={pageSettingKeys.stack} />
        </>
      }
    >
      <StackView
        tab={tab}
        onTab={(next) =>
          void navigate({
            to: '/stack',
            search: next === 'runtimes' ? {} : { tab: next },
            replace: true,
          })
        }
      />
    </Page>
  )
}
