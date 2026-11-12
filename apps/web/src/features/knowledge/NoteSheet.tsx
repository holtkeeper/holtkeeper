import type { KnowledgeEntry, PersonView, Scope } from '@holtkeeper/api'
import { Archive, Check, ExternalLink, Link2, Pencil, RotateCcw, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useKnowledgeEntry, useKnowledgeMutations } from '../../api/queries.ts'
import type { Space } from '../../lib/guide.ts'
import {
  isInherited,
  kbId,
  kindLabel,
  noteLink,
  noteStatusLabel,
  noteVersions,
  restoreInput,
  statusTone,
  taskKinds,
  visibilityOptions,
} from '../../lib/knowledge.ts'
import {
  Button,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  KeyValue,
  Markdown,
  Placeholder,
  SideSheet,
  Tag,
  notify,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { NoteEditor } from './NoteEditor.tsx'
import { Byline } from './parts.tsx'

type NoteTab = 'note' | 'history' | 'evidence'

const taskLabel = (id: string) => taskKinds.find((t) => t.id === id)?.label ?? id

const failed = (title: string) => (error: Error) => notify.error(title, messageOf(error))

/**
 * A note opened from the Notes table (`?note=<id>`): its text and where agents use it, its
 * previous versions with Restore, and its evidence links. With `creating` it is the form for a
 * new note instead.
 */
export function NoteSheet({
  entry,
  creating,
  space,
  groups,
  people,
  writable,
  index,
  total,
  onPrevious,
  onNext,
  onOpen,
  onClose,
}: {
  entry: KnowledgeEntry | undefined
  /** Scope a new note starts with; set while the form for a new note is open. */
  creating?: Scope
  space: Space
  groups: readonly string[]
  people: Readonly<Record<string, PersonView>>
  writable: boolean
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
  /** Opens another note, e.g. the one just created. */
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<NoteTab>('note')
  const [editingId, setEditingId] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const { review, remove } = useKnowledgeMutations()
  const detail = useKnowledgeEntry(entry?.id)

  if (creating)
    return (
      <SideSheet open onClose={onClose} title="New note">
        <NoteEditor
          initialScope={creating}
          groups={groups}
          onSaved={(saved) => onOpen(saved.id)}
          onCancel={onClose}
        />
      </SideSheet>
    )

  const act = (action: 'accept' | 'reject' | 'archive') =>
    entry &&
    review.mutate(
      { id: entry.id, action },
      {
        onSuccess: () =>
          notify.success(
            action === 'accept' ? 'Accepted' : action === 'reject' ? 'Rejected' : 'Archived',
            entry.title,
          ),
        onError: failed('Not changed'),
      },
    )

  const editing = entry !== undefined && editingId === entry.id
  const actions = !entry || !writable || editing ? [] : decisionsOf(entry, act)
  const history = detail.data?.history ?? []

  return (
    <SideSheet
      open={entry !== undefined}
      onClose={onClose}
      {...(entry ? { id: kbId(entry.id, true), copyId: kbId(entry.id) } : {})}
      title={entry?.title ?? 'Note'}
      {...(index !== undefined && total !== undefined ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
      {...(actions.length
        ? { quietActions: actions.length > 1 ? [actions[0]!, actions[1]!] : [actions[0]!] }
        : {})}
      {...(entry && writable && !editing
        ? {
            more: [
              { label: 'Edit', icon: Pencil, onAction: () => setEditingId(entry.id) },
              { label: 'Delete', icon: Trash2, danger: true, onAction: () => setDeleting(true) },
            ],
          }
        : {})}
      tabs={{
        'aria-label': 'Note details',
        selected: tab,
        onSelect: (id) => setTab(id === 'history' || id === 'evidence' ? id : 'note'),
        items: [
          { id: 'note', label: 'Note' },
          { id: 'history', label: 'History', badge: entry ? history.length + 1 : undefined },
          { id: 'evidence', label: 'Evidence', badge: entry?.evidence.length },
        ],
      }}
    >
      {entry ? (
        <div key={entry.id} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag tone={statusTone(entry.status)} dot>
                {noteStatusLabel[entry.status]}
              </Tag>
              <Tag>{kindLabel(entry.kind)}</Tag>
              <ScopeBadge scope={entry.scope} />
              {isInherited(entry, space) ? <Tag tone="info">Inherited</Tag> : null}
              {entry.subject ? <Tag mono>{entry.subject}</Tag> : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Byline
                verb={entry.source === 'agent' ? 'Proposed' : 'Written'}
                id={entry.author}
                at={entry.createdAt}
                people={people}
              />
              {entry.updatedBy ? (
                <Byline verb="edited" id={entry.updatedBy} at={entry.updatedAt} people={people} />
              ) : null}
            </div>
            {writable && entry.status === 'proposed' ? (
              <p className="text-xs text-dim">
                Accept makes it live for agents. Reject keeps it under Rejected; Archive stops
                agents reading a live note.
              </p>
            ) : null}
          </div>
          {tab === 'note' ? (
            editing ? (
              <NoteEditor
                key={entry.version}
                entry={entry}
                groups={groups}
                onSaved={() => setEditingId(undefined)}
                onCancel={() => setEditingId(undefined)}
              />
            ) : (
              <NoteBody entry={entry} />
            )
          ) : null}
          {tab === 'history' ? (
            <NoteHistory
              entry={entry}
              people={people}
              writable={writable}
              detail={detail}
              history={history}
            />
          ) : null}
          {tab === 'evidence' ? <NoteEvidence entry={entry} /> : null}
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
                  onClose()
                },
                onError: failed('Delete failed'),
              })
            }
          >
            Its history goes too. Archive it instead to keep the record while agents stop reading
            it.
          </ConfirmDialog>
        </div>
      ) : null}
    </SideSheet>
  )
}

function decisionsOf(
  entry: KnowledgeEntry,
  act: (action: 'accept' | 'reject' | 'archive') => void,
) {
  if (entry.status === 'proposed')
    return [
      { label: 'Accept', icon: Check, onPress: () => act('accept') },
      { label: 'Reject', icon: X, onPress: () => act('reject') },
    ]
  if (entry.status === 'accepted')
    return [{ label: 'Archive', icon: Archive, onPress: () => act('archive') }]
  return [{ label: 'Restore', icon: RotateCcw, onPress: () => act('accept') }]
}

function NoteBody({ entry }: { entry: KnowledgeEntry }) {
  const visibility = visibilityOptions.find((option) => option.id === (entry.visibility ?? 'team'))
  return (
    <div className="flex flex-col gap-4">
      <Markdown text={entry.body} className="text-[13px]" />
      <section className="flex flex-col gap-2.5 border-t border-line pt-3">
        <h3 className="text-[11.5px] font-medium text-muted">Where agents use it</h3>
        <KeyValue
          rows={[
            { label: 'Kind', value: kindLabel(entry.kind) },
            { label: 'Applies to', value: <ScopeBadge scope={entry.scope} /> },
            {
              label: 'Used by tasks',
              value: (
                <span className="flex flex-wrap gap-1">
                  {entry.appliesTo.map((id) => (
                    <Tag key={id}>{taskLabel(id)}</Tag>
                  ))}
                </span>
              ),
            },
            {
              label: 'Topics',
              value: entry.topics.length ? (
                <span className="flex flex-wrap gap-1">
                  {entry.topics.map((topic) => (
                    <Tag key={topic} mono>
                      {topic}
                    </Tag>
                  ))}
                </span>
              ) : null,
            },
            {
              label: 'Packages',
              value: entry.packages?.length ? (
                <span className="mono flex flex-col gap-0.5">
                  {entry.packages.map((pkg) => (
                    <span key={`${pkg.ecosystem}:${pkg.name}`}>
                      {pkg.ecosystem}:{pkg.name}
                      {pkg.from ? ` ${pkg.from}` : ''}
                      {pkg.to ? ` → ${pkg.to}` : ''}
                    </span>
                  ))}
                </span>
              ) : null,
            },
            {
              label: 'Visible to',
              value: visibility ? (
                <span>
                  {visibility.label} <span className="text-muted">· {visibility.hint}</span>
                </span>
              ) : null,
            },
            { label: 'Permalink', value: <span className="mono">{kbId(entry.id)}</span> },
          ]}
        />
        <CopyButton text={() => noteLink(window.location.origin, entry.id)} variant="ghost">
          <Link2 className="size-3.5" />
          Copy link
        </CopyButton>
      </section>
    </div>
  )
}

function NoteHistory({
  entry,
  people,
  writable,
  detail,
  history,
}: {
  entry: KnowledgeEntry
  people: Readonly<Record<string, PersonView>>
  writable: boolean
  detail: ReturnType<typeof useKnowledgeEntry>
  history: NonNullable<ReturnType<typeof useKnowledgeEntry>['data']>['history']
}) {
  const { update } = useKnowledgeMutations()
  if (detail.isPending) return <Placeholder className="h-24" />
  if (detail.isError) return <ErrorState error={detail.error} />
  return (
    <ol className="flex flex-col">
      {noteVersions(entry, history).map((row) => (
        <li
          key={row.version}
          className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 border-t border-line py-2.5 text-[12.5px] first:border-t-0 first:pt-0.5"
        >
          <span
            aria-hidden
            className={`mt-1 size-[9px] rounded-full border-[1.5px] ${row.current ? 'border-foreground bg-foreground' : 'border-muted'}`}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="mono">v{row.version}</span>
              <Byline
                verb={row.version === 1 ? 'written' : 'edited'}
                id={row.by}
                at={row.at}
                people={people}
              />
            </span>
            <span className="text-xs text-muted">
              {row.changed.length
                ? `Changed ${row.changed.join(', ')}`
                : row.version === 1 || !row.revision
                  ? 'First version'
                  : 'No content change'}
            </span>
          </div>
          {row.current ? (
            <Tag>Current</Tag>
          ) : writable && row.revision ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={update.isPending}
              onPress={() =>
                row.revision &&
                update.mutate(
                  { id: entry.id, input: restoreInput(entry, row.revision) },
                  {
                    onSuccess: () => notify.success(`Restored v${row.version}`, entry.title),
                    onError: failed('Not restored'),
                  },
                )
              }
            >
              Restore
            </Button>
          ) : (
            <span />
          )}
        </li>
      ))}
    </ol>
  )
}

function NoteEvidence({ entry }: { entry: KnowledgeEntry }) {
  if (!entry.evidence.length)
    return (
      <EmptyState
        title="No evidence"
        description="Links to merge requests, threads or docs that back the note show up here; add them under Details when editing."
      />
    )
  return (
    <ul className="flex flex-col gap-2 text-[12.5px]">
      {entry.evidence.map((link) => (
        <li key={link.url}>
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
          >
            <span className="truncate">{link.label}</span>
            <ExternalLink className="size-3 shrink-0 text-muted" />
          </a>
          {link.label !== link.url ? (
            <div className="mono truncate text-xs text-dim">{link.url}</div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
