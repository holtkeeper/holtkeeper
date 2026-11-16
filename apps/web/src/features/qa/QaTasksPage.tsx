import type { QaTaskRow } from '@holtkeeper/api'
import { useNavigate } from '@tanstack/react-router'
import { FlaskConical, PanelRight } from 'lucide-react'
import { useState } from 'react'

import { useQaTasks } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { foldScope } from '../../lib/home-scope.ts'
import { type QaPeriod, countsText, filterTasks, parseQaPeriod, qaPeriods } from '../../lib/qa.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  ListFooter,
  Notice,
  Page,
  Placeholder,
  Segmented,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'

const periodKey = 'holtkeeper.qa.days'

const readPeriod = (): QaPeriod => {
  try {
    return parseQaPeriod(localStorage.getItem(periodKey))
  } catch {
    return 30
  }
}

function Repos({ row }: { row: QaTaskRow }) {
  const [first, second, ...rest] = row.repos
  return (
    <span className="flex flex-wrap items-center gap-1">
      {[first, second].map((repo) =>
        repo ? (
          <Tag key={repoKey(repo)} mono title={repoKey(repo)}>
            {repo.path}
          </Tag>
        ) : null,
      )}
      {rest.length ? (
        <span className="text-xs text-dim" title={rest.map((repo) => repo.path).join(', ')}>
          +{rest.length}
        </span>
      ) : null}
    </span>
  )
}

function SummaryCell({ state }: { state: QaTaskRow['summary'] }) {
  if (state === 'fresh')
    return (
      <Tag tone="success" dot>
        Summary
      </Tag>
    )
  if (state === 'stale')
    return (
      <Tag tone="warning" dot title="New changes arrived after the summary">
        Outdated
      </Tag>
    )
  return <span className="text-xs text-dim">—</span>
}

/**
 * Releases › QA: tasks (ticket keys) with changes in the chosen period across the repositories
 * the viewer may read releases of, newest change first. Each row shows the task's title, the
 * repositories it touched, its merged, open and direct changes, the last change and whether a
 * summary exists; a row opens the task. Changes without a task are counted, not listed.
 */
export function QaTasksPage() {
  const [days, setDaysState] = useState<QaPeriod>(readPeriod)
  const [query, setQuery] = useState('')
  const list = useQaTasks(days)
  const navigate = useNavigate()
  const { view, setView, homeTeams } = useScope()
  const setDays = (next: QaPeriod) => {
    setDaysState(next)
    try {
      localStorage.setItem(periodKey, String(next))
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
  }
  const data = list.data
  const scoped = foldScope(data?.tasks ?? [], view, homeTeams, (row) => row.teams)
  const rows = filterTasks(scoped.shown, query)
  const open = (row: QaTaskRow) =>
    void navigate({ to: '/releases/qa/$key', params: { key: row.key } })

  return (
    <Page
      crumbs={[{ label: 'QA' }]}
      scope={{ value: view, onChange: setView, counts: scoped.counts }}
      search={{
        value: query,
        onChange: setQuery,
        'aria-label': 'Find a task',
        placeholder: 'Find a task, repository or author',
      }}
      filters={
        <Segmented
          aria-label="Period"
          size="sm"
          options={qaPeriods.map((period) => ({ id: String(period), label: `${period} days` }))}
          value={String(days)}
          onChange={(value) => setDays(parseQaPeriod(value))}
        />
      }
    >
      {list.isPending ? (
        <div className="flex flex-col gap-1">
          {[0, 1, 2, 3].map((i) => (
            <Placeholder key={i} className="h-10" />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState error={list.error} />
      ) : data ? (
        <div className="flex flex-col gap-3">
          {data.repos.pending > 0 ? (
            <Notice title="Reading repositories">
              {data.repos.read} of {data.repos.listed} read; the list fills in as the rest arrive.
            </Notice>
          ) : null}
          {data.repos.failed.length ? (
            <Notice tone="warning" title="Some repositories could not be read">
              <span className="mono text-xs">{data.repos.failed.slice(0, 5).join(', ')}</span>
              {data.repos.failed.length > 5 ? ` and ${data.repos.failed.length - 5} more` : ''}.
              They are tried again in a few minutes.
            </Notice>
          ) : null}
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {rows.length === 0 ? (
              <EmptyState
                icon={<FlaskConical />}
                title={query || scoped.others.length ? 'No task matches' : 'No tasks'}
                description={
                  scoped.others.length ? (
                    <>
                      {scoped.others.length} tasks of other teams are hidden.{' '}
                      <Button size="sm" variant="ghost" onPress={() => setView('all')}>
                        Show all
                      </Button>
                    </>
                  ) : (
                    `No change of the last ${days} days names a task.`
                  )
                }
              />
            ) : (
              <Table label="QA tasks">
                <thead>
                  <tr>
                    <Th>Task</Th>
                    <Th>Repositories</Th>
                    <Th>Changes</Th>
                    <Th>Last change</Th>
                    <Th>Summary</Th>
                    <Th>
                      <span className="sr-only">Open</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Tr key={row.key} onClick={() => open(row)}>
                      <Td>
                        <div className="flex min-w-0 flex-col">
                          <span className="mono text-[13px] font-semibold">{row.key}</span>
                          <span className="truncate text-xs text-muted" title={row.title}>
                            {row.title || 'No title'}
                            {row.issue?.status ? ` · ${row.issue.status}` : ''}
                          </span>
                        </div>
                      </Td>
                      <Td>
                        <Repos row={row} />
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-muted">
                        {countsText(row.counts)}
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-muted">
                        <span title={formatDateTime(row.lastAt)}>{formatRelative(row.lastAt)}</span>
                      </Td>
                      <Td>
                        <SummaryCell state={row.summary} />
                      </Td>
                      <Td align="right">
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          aria-label={`Open ${row.key}`}
                          onPress={() => open(row)}
                        >
                          <PanelRight className="size-3.5" />
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
            {data.tasks.length ? (
              <ListFooter
                className="border-t border-line"
                shown={rows.length}
                total={data.tasks.length}
                noun="tasks"
                {...(data.untracked
                  ? { caption: `· ${data.untracked} changes without a task are not listed` }
                  : {})}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </Page>
  )
}
