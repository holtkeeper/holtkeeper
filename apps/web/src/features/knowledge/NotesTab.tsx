import type { Family, KnowledgeEntry, PersonView } from '@holtkeeper/api'
import { Archive, BookOpen, Check, ExternalLink, Pencil, Plus, Trash2, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useKnowledge, useKnowledgeMutations } from '../../api/queries.ts'
import { type Space, settingScopeOfSpace } from '../../lib/guide.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import {
  type NoteFilter,
  type NoteGrouping,
  groupNotes,
  isInherited,
  kindLabel,
  matchesFilter,
  noteFilters,
  notesOfSpace,
  statusTone,
  taskKinds,
} from '../../lib/knowledge.ts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Markdown,
  OtherTeams,
  Placeholder,
  SearchInput,
  Segmented,
  Tag,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { NoteEditor } from './NoteEditor.tsx'
import { Byline } from './parts.tsx'

const taskLabel = (id: string) => taskKinds.find((t) => t.id === id)?.label ?? id

const matchesText = (entry: KnowledgeEntry, needle: string) =>
  !needle ||
  entry.title.toLowerCase().includes(needle) ||
  entry.body.toLowerCase().includes(needle) ||
  entry.topics.some((topic) => topic.includes(needle))

/**
 * Notes of a space as cards grouped by topic or kind. Proposals from agents and MCP come first
 * with Accept and Reject; editing happens in place.
 */
export function NotesTab({
  space,
  families,
  groups,
}: {
  space: Space
  families: readonly Family[]
  /** Known groups, offered in the scope editor. */
  groups: readonly string[]
}) {
  const { can } = useSession()
  const { homeGroups } = useScope()
  const knowledge = useKnowledge(space.kind === 'repo' ? { repo: space.repo } : {})
  const [filter, setFilter] = useState<NoteFilter>('live')
  const [grouping, setGrouping] = useState<NoteGrouping>('topic')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const writable = can('knowledge:write')
  const members =
    space.kind === 'family' ? (families.find((f) => f.id === space.family)?.members ?? []) : []

  if (knowledge.isPending)
    return (
      <div className="flex flex-col gap-3">
        <Placeholder className="h-24" />
        <Placeholder className="h-24" />
      </div>
    )
  if (knowledge.isError) return <ErrorState error={knowledge.error} />

  const { people } = knowledge.data
  const inSpace = notesOfSpace(knowledge.data.entries, space, members)
  const needle = query.trim().toLowerCase()
  const shown = inSpace.filter((e) => matchesFilter(e, filter) && matchesText(e, needle))
  const proposals = shown.filter((e) => e.status === 'proposed')
  const owners = new Map(knowledge.data.entries.map((entry) => [entry.id, entry.owner]))
  const folded = foldOtherTeams(
    shown.filter((e) => e.status !== 'proposed'),
    space.kind === 'all' ? homeGroups : [],
    (entry) => owners.get(entry.id) ?? [],
  )
  const rest = groupNotes(folded.mine, grouping)
  const counts = Object.fromEntries(
    noteFilters.map((f) => [f.id, inSpace.filter((e) => matchesFilter(e, f.id)).length]),
  )

  const card = (entry: KnowledgeEntry) =>
    editing === entry.id ? (
      <NoteEditor key={entry.id} entry={entry} groups={groups} onClose={() => setEditing(null)} />
    ) : (
      <NoteCard
        key={entry.id}
        entry={entry}
        space={space}
        people={people}
        writable={writable}
        onEdit={() => setEditing(entry.id)}
      />
    )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Status"
          options={noteFilters.map((f) => ({
            id: f.id,
            label: (
              <span className="inline-flex items-center gap-1.5">
                {f.label}
                <span className="tabular text-muted">{counts[f.id] ?? 0}</span>
              </span>
            ),
          }))}
          value={filter}
          onChange={setFilter}
        />
        <Segmented
          aria-label="Group by"
          options={[
            { id: 'topic', label: 'By topic' },
            { id: 'kind', label: 'By kind' },
          ]}
          value={grouping}
          onChange={setGrouping}
        />
        <SearchInput
          aria-label="Filter notes"
          placeholder="Filter by text or topic"
          value={query}
          onChange={setQuery}
          className="w-56"
        />
        {writable ? (
          <Button variant="primary" size="sm" className="ml-auto" onPress={() => setEditing('new')}>
            <Plus className="size-3.5" />
            New note
          </Button>
        ) : null}
      </div>

      {editing === 'new' ? (
        <NoteEditor
          initialScope={settingScopeOfSpace(space, members)}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {shown.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title={
            needle ? 'Nothing matches' : filter === 'live' ? 'No notes yet' : `No ${filter} notes`
          }
          description={
            filter === 'live'
              ? 'Notes are atomic facts picked per task: decisions, quirks, migrations. Agents propose them too; proposals wait here.'
              : undefined
          }
        />
      ) : null}

      {proposals.length ? (
        <NoteGroupView label="Waiting for review" count={proposals.length}>
          {proposals.map(card)}
        </NoteGroupView>
      ) : null}
      {rest.map((group) => (
        <NoteGroupView key={group.id || '-'} label={group.label} count={group.entries.length}>
          {group.entries.map(card)}
        </NoteGroupView>
      ))}
      <OtherTeams count={folded.others.length} teams={folded.teams}>
        <div className="flex flex-col gap-2">{folded.others.map(card)}</div>
      </OtherTeams>
    </div>
  )
}

function NoteGroupView({
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
        <span className="mono font-normal text-dim">{count}</span>
      </h2>
      <div className="grid gap-2 lg:grid-cols-2">{children}</div>
    </section>
  )
}

function NoteCard({
  entry,
  space,
  people,
  writable,
  onEdit,
}: {
  entry: KnowledgeEntry
  space: Space
  people: Readonly<Record<string, PersonView>>
  writable: boolean
  onEdit: () => void
}) {
  const { review, remove } = useKnowledgeMutations()
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const act = (action: 'accept' | 'reject' | 'archive') =>
    review.mutate(
      { id: entry.id, action },
      {
        onSuccess: () =>
          notify.success(
            action === 'accept' ? 'Accepted' : action === 'reject' ? 'Rejected' : 'Archived',
            entry.title,
          ),
        onError: (error) => notify.error('Not changed', messageOf(error)),
      },
    )

  return (
    <article className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          className="min-w-0 text-left text-[13px] font-medium hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {entry.title}
        </button>
        {writable ? (
          <div className="flex shrink-0 gap-0.5">
            {entry.status === 'proposed' ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => act('accept')}
                  isDisabled={review.isPending}
                >
                  <Check className="size-3.5" />
                  Accept
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => act('reject')}
                  isDisabled={review.isPending}
                >
                  <X className="size-3.5" />
                  Reject
                </Button>
              </>
            ) : null}
            {entry.status === 'rejected' || entry.status === 'archived' ? (
              <Button
                variant="ghost"
                size="sm"
                onPress={() => act('accept')}
                isDisabled={review.isPending}
              >
                Restore
              </Button>
            ) : null}
            {entry.status === 'accepted' ? (
              <Tooltip content="No longer true: agents stop reading it">
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label={`Archive ${entry.title}`}
                  onPress={() => act('archive')}
                  isDisabled={review.isPending}
                >
                  <Archive className="size-3.5" />
                </Button>
              </Tooltip>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={`Edit ${entry.title}`}
              onPress={onEdit}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={`Delete ${entry.title}`}
              onPress={() => setDeleting(true)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.status === 'accepted' ? null : (
          <Tag tone={statusTone(entry.status)} dot>
            {entry.status}
          </Tag>
        )}
        <Tag>{kindLabel(entry.kind)}</Tag>
        <ScopeBadge scope={entry.scope} />
        {isInherited(entry, space) ? <Tag tone="info">inherited</Tag> : null}
        {entry.visibility === 'shared' ? (
          <Tooltip content="Other teams read it through the cross-team catalog">
            <Tag tone="accent">shared</Tag>
          </Tooltip>
        ) : null}
        {entry.subject ? <Tag mono>{entry.subject}</Tag> : null}
      </div>
      <Markdown text={entry.body} className={`text-muted ${open ? '' : 'line-clamp-3'}`} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Byline
          verb={entry.source === 'agent' ? 'proposed' : 'written'}
          id={entry.author}
          at={entry.updatedBy ? undefined : entry.updatedAt}
          people={people}
        />
        {entry.updatedBy ? (
          <Byline verb="edited" id={entry.updatedBy} at={entry.updatedAt} people={people} />
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-line pt-2 text-xs text-muted">
          <span>
            Tasks: {entry.appliesTo.map(taskLabel).join(', ')}
            {entry.topics.length ? ` · Topics: ${entry.topics.join(', ')}` : ''}
          </span>
          {entry.packages?.length ? (
            <span className="mono">
              {entry.packages
                .map(
                  (pkg) =>
                    `${pkg.ecosystem}:${pkg.name}${pkg.from ? ` ${pkg.from}` : ''}${pkg.to ? ` → ${pkg.to}` : ''}`,
                )
                .join(', ')}
            </span>
          ) : null}
          {entry.evidence.length ? (
            <span className="flex flex-wrap gap-2">
              {entry.evidence.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                >
                  {link.label}
                  <ExternalLink className="size-3" />
                </a>
              ))}
            </span>
          ) : null}
          <span className="mono">kb:{entry.id}</span>
        </div>
      ) : null}
      <ConfirmDialog
        isOpen={deleting}
        onOpenChange={setDeleting}
        title="Delete this note?"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(entry.id, {
            onSuccess: () => {
              notify.success('Note deleted')
              setDeleting(false)
            },
            onError: (error) => notify.error('Delete failed', messageOf(error)),
          })
        }
      >
        Its history goes too. Archive it instead to keep the record while agents stop reading it.
      </ConfirmDialog>
    </article>
  )
}
