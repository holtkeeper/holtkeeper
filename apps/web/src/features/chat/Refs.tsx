import type { ChatMessageRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { BookOpen, FolderGit2, GitMerge, ListChecks, Play, type LucideIcon } from 'lucide-react'

import { refKey, refLabel } from '../../lib/chat.ts'
import { parseRepoKey, repoSplat } from '../../lib/repo.ts'

const icons: Record<ChatMessageRef['kind'], LucideIcon> = {
  repo: FolderGit2,
  note: BookOpen,
  task: ListChecks,
  job: Play,
  mr: GitMerge,
}

const chipClass =
  'mono inline-flex h-5 max-w-full items-center gap-1 rounded-[5px] border border-line bg-raise px-1.5 text-[11px] text-muted no-underline transition-colors hover:text-foreground'

/** One stored ref as a chip that opens what it names: a repository, note, task, run or merge request. */
function RefChip({ value: ref }: { value: ChatMessageRef }) {
  const Icon = icons[ref.kind]
  const body = (
    <>
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{refLabel(ref)}</span>
    </>
  )
  if (ref.kind === 'repo' || ref.kind === 'mr') {
    const repo = parseRepoKey(ref.repo)
    if (!repo) return <span className={chipClass}>{body}</span>
    return (
      <Link
        to="/repos/$"
        params={{ _splat: repoSplat(repo) }}
        search={ref.kind === 'mr' ? { tab: 'activity' } : {}}
        className={chipClass}
      >
        {body}
      </Link>
    )
  }
  if (ref.kind === 'task')
    return (
      <Link to="/ops/tasks" search={{ group: ref.id }} className={chipClass}>
        {body}
      </Link>
    )
  if (ref.kind === 'job')
    return (
      <Link to="/ops/runs/$jobId" params={{ jobId: ref.id }} className={chipClass}>
        {body}
      </Link>
    )
  return (
    <Link to="/knowledge/notes" search={{ note: ref.id }} className={chipClass}>
      {body}
    </Link>
  )
}

/** The refs a message was stored with, as a row of chips; nothing when it has none. */
export function RefChips({ refs }: { refs: readonly ChatMessageRef[] }) {
  if (refs.length === 0) return null
  return (
    <ul aria-label="Refers to" className="flex flex-wrap gap-1">
      {refs.map((ref) => (
        <li key={refKey(ref)} className="min-w-0">
          <RefChip value={ref} />
        </li>
      ))}
    </ul>
  )
}
