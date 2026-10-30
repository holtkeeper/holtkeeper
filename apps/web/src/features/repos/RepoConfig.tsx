import type { RepoExplain, RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { CalendarClock, Layers, Puzzle, Tags, Zap } from 'lucide-react'
import type { ReactNode } from 'react'

import { useExplainRepo } from '../../api/queries.ts'
import { Chip, ErrorState, Panel, Placeholder, Table, Td, Th } from '../../ui/index.ts'

function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-dashed border-separator p-3 text-sm text-muted [&_svg]:size-4">
      {icon}
      {children}
    </div>
  )
}

function Analyzers({ analyzers }: { analyzers: readonly string[] }) {
  return analyzers.length ? (
    <span className="flex flex-wrap gap-1">
      {analyzers.map((analyzer) => (
        <Chip key={analyzer} size="sm" className="font-mono">
          {analyzer}
        </Chip>
      ))}
    </span>
  ) : (
    <span className="text-muted">—</span>
  )
}

const traitValue = (value: string | number | boolean) =>
  typeof value === 'string' ? value : JSON.stringify(value)

/** What the config applies to one repository: groups, traits, plugins, schedules and triggers. */
export function RepoConfig({ repo }: { repo: RepoRef }) {
  const explain = useExplainRepo(repo)
  if (explain.isPending) return <Placeholder className="h-64" />
  if (explain.isError) return <ErrorState error={explain.error} />
  const view = explain.data
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <GroupsPanel groups={view.groups} />
        <TraitsPanel traits={view.traits} />
      </div>
      <PluginsPanel plugins={view.plugins} />
      <JobsPanel view={view} />
    </div>
  )
}

function GroupsPanel({ groups }: { groups: readonly string[] }) {
  return (
    <Panel title="Groups" description="Groups select settings, grants and schedules together.">
      {groups.length ? (
        <span className="flex flex-wrap gap-1.5">
          {groups.map((group) => (
            <Link key={group} to="/repos/groups/$groupId" params={{ groupId: group }}>
              <Chip className="hover:underline">{group}</Chip>
            </Link>
          ))}
        </span>
      ) : (
        <Empty icon={<Layers />}>Not in any group.</Empty>
      )}
    </Panel>
  )
}

function TraitsPanel({ traits }: { traits: RepoExplain['traits'] }) {
  const entries = Object.entries(traits).toSorted(([a], [b]) => a.localeCompare(b))
  return (
    <Panel title="Traits" description="Facts about the repository that settings and plugins read.">
      {entries.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-xs leading-5 text-muted">{key}</dt>
              <dd className="min-w-0 break-words font-mono text-xs leading-5">
                {traitValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <Empty icon={<Tags />}>No traits set.</Empty>
      )}
    </Panel>
  )
}

function PluginsPanel({ plugins }: { plugins: RepoExplain['plugins'] }) {
  return (
    <Panel
      title="Plugins"
      description="Plugins that run for this repository, with their final options."
    >
      {plugins.length ? (
        <ul className="flex flex-col divide-y divide-separator">
          {plugins.map((plugin) => (
            <li key={plugin.name} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Puzzle className="size-4 text-muted" />
                <span className="font-mono">{plugin.name}</span>
              </span>
              {plugin.options !== undefined ? (
                <pre className="max-h-64 overflow-auto rounded-xl border border-border bg-default px-3 py-2 font-mono text-xs">
                  {JSON.stringify(plugin.options, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon={<Puzzle />}>No plugins apply.</Empty>
      )}
    </Panel>
  )
}

function JobsPanel({ view }: { view: RepoExplain }) {
  const { schedules, triggers } = view
  return (
    <Panel
      title="Automation"
      description="Schedules and triggers that queue jobs for this repository."
    >
      {schedules.length || triggers.length ? (
        <Table label="Schedules and triggers">
          <thead>
            <tr>
              <Th>Kind</Th>
              <Th>Name</Th>
              <Th>Analyzers</Th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((schedule) => (
              <tr key={`schedule:${schedule.name}`}>
                <Td>
                  <span className="flex items-center gap-1.5 text-muted">
                    <CalendarClock className="size-3.5" />
                    Schedule
                  </span>
                </Td>
                <Td>
                  <Link
                    to="/automation"
                    search={{ tab: 'schedules' }}
                    className="font-medium hover:underline"
                  >
                    {schedule.title ?? schedule.name}
                  </Link>
                  {schedule.title ? (
                    <span className="ml-2 font-mono text-xs text-muted">{schedule.name}</span>
                  ) : null}
                </Td>
                <Td>
                  <Analyzers analyzers={schedule.analyzers} />
                </Td>
              </tr>
            ))}
            {triggers.map((trigger) => (
              <tr key={`trigger:${trigger.id}`}>
                <Td>
                  <span className="flex items-center gap-1.5 text-muted">
                    <Zap className="size-3.5" />
                    Trigger
                  </span>
                </Td>
                <Td>
                  <Link
                    to="/automation"
                    search={{ tab: 'triggers' }}
                    className="font-mono hover:underline"
                  >
                    {trigger.id}
                  </Link>
                </Td>
                <Td>
                  <Analyzers analyzers={trigger.analyzers} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <Empty icon={<CalendarClock />}>No schedules or triggers queue jobs here.</Empty>
      )}
    </Panel>
  )
}
