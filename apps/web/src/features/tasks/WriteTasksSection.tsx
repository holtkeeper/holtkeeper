import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useSettingMutations, useSettings, useWriteTasks } from '../../api/queries.ts'
import { formatCost } from '../../lib/chat.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { writePoolLabel, writePoolState, writeTasksSwitch } from '../../lib/tasks.ts'
import { ErrorState, Placeholder, SegmentBar, Switch, Tag, notify } from '../../ui/index.ts'
import { SettingEntries } from '../settings/SettingEntries.tsx'
import { SettingsSection } from '../settings/SettingsSection.tsx'
import { useSession } from '../shell/session.ts'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] text-dim">{label}</dt>
      <dd className="min-w-0 truncate text-[13px]">{children}</dd>
    </div>
  )
}

const ago = (at: string | undefined, now: Date) =>
  at ? (
    <time dateTime={at} title={formatDateTime(at)} className="mono text-xs">
      {formatRelative(at, now)}
    </time>
  ) : (
    <span className="text-dim">—</span>
  )

/**
 * Settings → System: the write tasks kill switch, the write worker pool's state (queued and
 * running tasks, the oldest wait, the last start and the workers running now), this week's spend
 * against the weekly cap, and the `tasks.write` entries for the caps.
 */
export function WriteTasksSection() {
  const { canGlobal } = useSession()
  const status = useWriteTasks()
  const settings = useSettings(canGlobal('settings:read'))
  const { put } = useSettingMutations()
  const [now] = useState(() => new Date())
  if (!canGlobal('settings:read')) return null
  const definition = settings.data?.definitions.find((each) => each.key === 'tasks.write')

  const toggle = (enabled: boolean) =>
    put.mutate(writeTasksSwitch(settings.data?.settings ?? [], enabled), {
      onSuccess: () => {
        void status.refetch()
        notify.success(enabled ? 'Write tasks turned on' : 'Write tasks turned off')
      },
      onError: (error) => notify.error('Not saved', messageOf(error)),
    })

  const body = () => {
    if (status.isPending) return <Placeholder className="h-24" />
    if (status.isError) return <ErrorState error={status.error} />
    const data = status.data
    const state = writePoolLabel[writePoolState(data, now)]
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            label="Agents may change code"
            isSelected={data.enabled}
            isDisabled={!canGlobal('settings:write') || put.isPending || !settings.data}
            onChange={toggle}
          />
          <Tag tone={state.tone} dot className="ml-auto">
            {state.label}
          </Tag>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Queued">
            <span className="mono tabular">{data.pool.queued}</span>
          </Fact>
          <Fact label="Running">
            <span className="mono tabular">{data.pool.running}</span>
          </Fact>
          <Fact label="Oldest waiting">{ago(data.pool.oldestQueuedAt, now)}</Fact>
          <Fact label="Last started">{ago(data.pool.lastStartedAt, now)}</Fact>
        </dl>
        {data.pool.workers?.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-dim">Workers</span>
            {data.pool.workers.map((worker) => (
              <Tag key={worker} mono>
                {worker}
              </Tag>
            ))}
          </div>
        ) : null}
        {data.spentUsd !== undefined ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted">Spent this week</span>
              <span className="mono">
                {formatCost(data.spentUsd)}
                <span className="text-muted"> of {formatCost(data.weeklyUsd)}</span>
              </span>
            </div>
            <SegmentBar
              segments={[
                {
                  value: Math.min(data.spentUsd, data.weeklyUsd),
                  tone: data.spentUsd >= data.weeklyUsd ? 'danger' : 'accent',
                  label: 'spent',
                },
              ]}
              total={data.weeklyUsd}
            />
          </div>
        ) : null}
        <p className="text-xs text-muted">
          Caps: <span className="mono">{formatCost(data.perRepoUsd)}</span> per repository,{' '}
          <span className="mono">{formatCost(data.perGroupUsd)}</span> per task, at most{' '}
          {data.maxRepos} repositories. Tasks run only on write workers (
          <code className="mono">serve --pool write</code>).{' '}
          <Link to="/tasks" className="text-foreground hover:underline">
            Open Tasks
          </Link>
        </p>
      </div>
    )
  }

  return (
    <SettingsSection
      title="Write tasks"
      description="Whether agents may push branches and open merge requests, and how the write workers are doing"
    >
      {body()}
      {settings.data && definition ? (
        <SettingEntries data={settings.data} definition={definition} />
      ) : null}
    </SettingsSection>
  )
}
