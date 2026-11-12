import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useRepos, useSettingMutations, useSettings, useWriteTasks } from '../../api/queries.ts'
import { canReadSpend } from '../../lib/access.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import {
  writePoolLabel,
  writePoolState,
  writeTasksEntry,
  writeTasksSwitch,
  writeWorkersText,
} from '../../lib/tasks.ts'
import { useNow } from '../../lib/use-now.ts'
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Placeholder,
  SegmentBar,
  Switch,
  Tag,
  notify,
} from '../../ui/index.ts'
import { EntryDialog } from '../settings/EntryDialog.tsx'
import { useSession } from '../shell/session.ts'

function Ago({ at, now }: { at: string | undefined; now: Date }) {
  return at ? (
    <time dateTime={at} title={formatDateTime(at)} className="mono">
      {formatRelative(at, now)}
    </time>
  ) : (
    <span className="text-dim">—</span>
  )
}

function Cell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 border-line px-4 py-3 not-first:border-t md:not-first:border-t-0 md:not-first:border-l">
      {title ? <span className="text-[11.5px] text-muted">{title}</span> : null}
      {children}
    </div>
  )
}

function Facts({ rows }: { rows: readonly [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="mono text-right tabular">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Risks() {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>Approved tasks then push branches and open draft merge requests on write workers.</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-muted">
        <li>
          Agents run each repository's own scripts (install, build, tests) on the write workers
          without a sandbox: they can read what the worker can read, including its environment and
          other checkouts, and change the mirror's git config.
        </li>
        <li>Merge requests are opened with the forge token, under the bot's name.</li>
        <li>
          A wrong change can reach many repositories at once; review every draft before merging.
        </li>
        <li>Every task spends from the weekly AI budget, up to the caps on this page.</li>
      </ul>
      <p className="text-muted">
        Tasks still start only after someone with <code className="mono">tasks:run</code> on their
        repositories approves them. Turning this off later holds queued tasks.
      </p>
    </div>
  )
}

/**
 * The write tasks control strip at the top of Ops › Tasks: the `tasks.write` switch ("Agents may
 * change code"; turning it on asks first and names the risks, turning it off holds queued tasks),
 * who changed it last, the write pool (busy workers, queued and running tasks, oldest wait, last
 * start), this week's spend against the weekly cap, and the caps with an editor for the global
 * `tasks.write` entry. Changing anything needs `settings:write` over everything.
 */
export function WriteControl() {
  const { canGlobal, can } = useSession()
  const status = useWriteTasks()
  const readable = canGlobal('settings:read')
  const writable = canGlobal('settings:write')
  const settings = useSettings(readable)
  const repos = useRepos(writable && can('repos:read'))
  const { put } = useSettingMutations()
  const now = useNow()
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)

  if (status.isPending) return <Placeholder className="h-28" />
  if (status.isError) return <ErrorState error={status.error} />
  const data = status.data
  const entry = writeTasksEntry(settings.data?.settings ?? [])
  const definition = settings.data?.definitions.find((each) => each.key === 'tasks.write')
  const changedBy =
    entry?.updatedBy && settings.data ? personOf(settings.data.people, entry.updatedBy) : undefined
  const state = writePoolLabel[writePoolState(data, now)]
  const spent = data.spentUsd

  const toggle = (enabled: boolean) =>
    put.mutate(writeTasksSwitch(settings.data?.settings ?? [], enabled), {
      onSuccess: () => {
        setConfirming(false)
        void status.refetch()
        notify.success(enabled ? 'Agents may change code' : 'Agents may no longer change code')
      },
      onError: (error) => {
        setConfirming(false)
        notify.error('Not saved', messageOf(error))
      },
    })

  return (
    <section
      aria-label="Write tasks control"
      className="grid overflow-hidden rounded-xl border border-line bg-panel text-[13px] md:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))]"
    >
      <Cell>
        <div className="flex flex-wrap items-center gap-2">
          <Switch
            label="Agents may change code"
            isSelected={data.enabled}
            isDisabled={!writable || put.isPending || !settings.data}
            onChange={(enabled) => (enabled ? setConfirming(true) : toggle(false))}
          />
          <Tag tone={data.enabled ? 'success' : 'default'} dot>
            {data.enabled ? 'On' : 'Off'}
          </Tag>
        </div>
        <p className="text-xs text-muted">
          Agents push branches and open draft merge requests on write workers. Turning this off
          holds queued tasks; running repositories finish their current step.
        </p>
        {entry ? (
          <p className="text-[11.5px] text-dim">
            Changed
            {changedBy ? (
              <>
                {' '}
                by <span className="text-foreground">{changedBy.name}</span>
              </>
            ) : null}{' '}
            <Ago at={entry.updatedAt} now={now} />
            {canGlobal('audit:read') ? (
              <>
                {' · '}
                <Link
                  to="/settings/$section"
                  params={{ section: 'audit' }}
                  className="hover:underline"
                >
                  Audit log
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </Cell>
      <Cell title="Write pool">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">
            <span className="mono tabular">{data.pool.running}</span>
            <span className="text-xs font-normal text-muted"> running</span>
          </span>
          <Tag tone={state.tone} dot>
            {state.label}
          </Tag>
        </div>
        {data.pool.workers?.length ? (
          <div className="flex flex-wrap gap-1">
            {data.pool.workers.map((worker) => (
              <Tag key={worker} mono>
                {worker}
              </Tag>
            ))}
          </div>
        ) : null}
        <Facts
          rows={[
            [
              'Workers',
              <span
                key="workers"
                className="mono tabular"
                title="Busy write workers / live workers of every pool"
              >
                {writeWorkersText(data.pool)}
              </span>,
            ],
            ['Queued', data.pool.queued],
            ['Running', data.pool.running],
            ['Oldest wait', <Ago key="wait" at={data.pool.oldestQueuedAt} now={now} />],
            ['Last start', <Ago key="start" at={data.pool.lastStartedAt} now={now} />],
          ]}
        />
      </Cell>
      <Cell title="Spent this week">
        {spent === undefined ? (
          <span className="text-xs text-muted">Needs AI or settings read access.</span>
        ) : (
          <>
            <span className="mono text-[15px] font-semibold tabular">
              {formatUsd(spent)}
              <span className="text-xs font-normal text-muted">
                {' '}
                of {formatUsd(data.weeklyUsd)}
              </span>
            </span>
            <SegmentBar
              segments={[
                {
                  value: Math.min(spent, data.weeklyUsd),
                  tone: spent >= data.weeklyUsd ? 'danger' : 'accent',
                  label: 'spent',
                },
              ]}
              total={data.weeklyUsd}
            />
          </>
        )}
        <span className="text-[11.5px] text-dim">
          part of the weekly AI budget
          {canReadSpend(can) ? (
            <>
              {' · '}
              <Link to="/ops/spend" className="hover:underline">
                AI spend
              </Link>
            </>
          ) : null}
        </span>
      </Cell>
      <Cell title="Caps">
        <Facts
          rows={[
            ['Per repository', formatUsd(data.perRepoUsd)],
            ['Per task', formatUsd(data.perGroupUsd)],
            ['Repositories per task', data.maxRepos],
            ['Weekly', formatUsd(data.weeklyUsd)],
          ]}
        />
        {writable && definition ? (
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            onPress={() => setEditing(true)}
          >
            Edit caps
          </Button>
        ) : null}
      </Cell>
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title="Let agents change code?"
        confirmLabel="Turn on"
        isPending={put.isPending}
        onConfirm={() => toggle(true)}
      >
        <Risks />
      </ConfirmDialog>
      {editing && definition ? (
        <EntryDialog
          definition={definition}
          {...(entry ? { entry } : { initialScope: { all: true } })}
          groups={[...new Set((repos.data?.repos ?? []).flatMap((repo) => repo.groups))].toSorted()}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </section>
  )
}
