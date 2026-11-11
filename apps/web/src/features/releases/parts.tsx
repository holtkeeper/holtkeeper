import type {
  ReleaseBoardRow,
  ReleaseBump,
  ReleaseEntry,
  ReleaseLink,
  ReleaseLinkKind,
  ReleaseTask,
} from '@holtkeeper/api'
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  FolderGit2,
  GitBranch,
  GitCompare,
  GitMerge,
  GitPullRequest,
  OctagonAlert,
  Package,
  Server,
  Tag as TagIcon,
  Tags,
  Workflow,
} from 'lucide-react'
import type { ReactNode } from 'react'

import {
  bumpTones,
  entryGroups,
  issueTones,
  type PlanTask,
  stageTones,
  stageText,
} from '../../lib/releases.ts'
import { Tag } from '../../ui/index.ts'

export function StageTag({ row }: { row: ReleaseBoardRow }) {
  return (
    <Tag tone={row.error ? 'danger' : stageTones[row.stage]} dot>
      {stageText(row)}
    </Tag>
  )
}

export function BumpTag({ bump }: { bump: ReleaseBump | undefined }) {
  return bump && bump !== 'none' ? <Tag tone={bumpTones[bump]}>{bump}</Tag> : null
}

/** Changelog entries grouped by type, breaking changes first; left-out ones are not shown. */
export function EntryGroupsView({
  entries,
  renderEntry,
}: {
  entries: readonly ReleaseEntry[]
  renderEntry?: (entry: ReleaseEntry) => ReactNode
}) {
  const { groups } = entryGroups(entries)
  if (!groups.length) return <p className="text-sm text-muted">No changes.</p>
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <section key={group.id}>
          <h4 className="mb-1 flex items-center gap-2 text-xs text-dim">
            {group.title}
            <span className="tabular">{group.entries.length}</span>
          </h4>
          <ul className="flex flex-col gap-1 text-sm">
            {group.entries.map((entry) =>
              renderEntry ? (
                <li key={entry.id}>{renderEntry(entry)}</li>
              ) : (
                <li key={entry.id} className="flex items-baseline gap-2">
                  {entry.scope ? (
                    <span className="mono shrink-0 text-xs text-muted">{entry.scope}</span>
                  ) : null}
                  <span className="min-w-0">{entry.text}</span>
                  {entry.tickets.map((ticket) => (
                    <span key={ticket} className="mono shrink-0 text-xs text-dim">
                      {ticket}
                    </span>
                  ))}
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * Tracker keys with the titles that name them, or the tracker's title and status when it is
 * connected; keys link to the tracker when a URL is known.
 */
export function TaskList({ tasks }: { tasks: readonly (PlanTask | ReleaseTask)[] }) {
  if (!tasks.length) return <p className="text-sm text-muted">No tracker keys in these commits.</p>
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {tasks.map((task) => (
        <li key={task.key} className="flex items-baseline gap-2">
          {task.url ? (
            <a
              href={task.url}
              target="_blank"
              rel="noreferrer"
              className="mono shrink-0 text-xs hover:underline"
            >
              {task.key}
            </a>
          ) : (
            <span className="mono shrink-0 text-xs">{task.key}</span>
          )}
          <span className="min-w-0 truncate text-muted" title={task.titles.join('\n')}>
            {task.issue?.title ?? task.titles[0] ?? ''}
          </span>
          {task.issue?.status && (
            <Tag tone={task.issue.category ? issueTones[task.issue.category] : 'default'}>
              {task.issue.status}
            </Tag>
          )}
          <span className="tabular ml-auto shrink-0 text-xs text-dim">{task.commits}</span>
        </li>
      ))}
    </ul>
  )
}

const pipelineIcon = (status: string | undefined) => {
  if (status === 'success') return <CircleCheck className="size-3.5 text-ok" />
  if (status === 'failed' || status === 'canceled') return <CircleX className="size-3.5 text-bad" />
  return <CircleDashed className="size-3.5 text-muted" />
}

const linkIcons: Record<ReleaseLinkKind, ReactNode> = {
  'merge-request': <GitMerge className="size-3.5" />,
  blocker: <OctagonAlert className="size-3.5 text-bad" />,
  tag: <TagIcon className="size-3.5" />,
  compare: <GitCompare className="size-3.5" />,
  pipeline: <Workflow className="size-3.5" />,
  repository: <FolderGit2 className="size-3.5" />,
  'merge-requests': <GitPullRequest className="size-3.5" />,
  branches: <GitBranch className="size-3.5" />,
  tags: <Tags className="size-3.5" />,
  releases: <Package className="size-3.5" />,
  pipelines: <Workflow className="size-3.5" />,
  environments: <Server className="size-3.5" />,
}

/** Forge links of the current release: merge requests, tags, diffs and pipelines. */
export function ReleaseLinks({ links }: { links: readonly ReleaseLink[] }) {
  const current = links.filter((link) => link.group === 'current')
  if (!current.length) return null
  return (
    <nav aria-label="Forge links" className="flex flex-wrap gap-1.5">
      {current.map((link) => (
        <a
          key={`${link.kind}-${link.url}`}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          title={link.status ? `${link.label}: ${link.status}` : link.url}
          className="inline-flex h-6 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-muted hover:border-line-strong hover:text-foreground"
        >
          {link.status ? pipelineIcon(link.status) : linkIcons[link.kind]}
          {link.label}
        </a>
      ))}
    </nav>
  )
}
