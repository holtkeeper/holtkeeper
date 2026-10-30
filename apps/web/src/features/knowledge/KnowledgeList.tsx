import type { KnowledgeEntry } from '@holtkeeper/api'
import { Archive, Bot, Check, ExternalLink, Pencil, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useKnowledgeMutations } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { kindLabel, statusTone, taskKinds } from '../../lib/knowledge.ts'
import { Button, Chip, ConfirmDialog, Markdown, Tooltip, notify } from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'

const taskLabel = (id: string) => taskKinds.find((t) => t.id === id)?.label ?? id

/** Knowledge entries as cards with review actions; `onEdit` opens the editor. */
export function KnowledgeList({
  entries,
  writable,
  onEdit,
}: {
  entries: readonly KnowledgeEntry[]
  writable: boolean
  onEdit: (entry: KnowledgeEntry) => void
}) {
  const { review, remove } = useKnowledgeMutations()
  const [deleting, setDeleting] = useState<KnowledgeEntry | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const act = (entry: KnowledgeEntry, action: 'accept' | 'reject' | 'archive') =>
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
    <>
      <ul className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {entries.map((entry) => {
            const open = expanded.has(entry.id)
            return (
              <motion.li
                key={entry.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 shadow-surface"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous)
                          if (next.has(entry.id)) next.delete(entry.id)
                          else next.add(entry.id)
                          return next
                        })
                      }
                    >
                      {entry.title}
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <Chip tone={statusTone(entry.status)}>{entry.status}</Chip>
                      <Chip>{kindLabel(entry.kind)}</Chip>
                      <ScopeBadge scope={entry.scope} />
                      {entry.source === 'agent' ? (
                        <Chip tone="accent">
                          <Bot className="size-3" />
                          {entry.author}
                        </Chip>
                      ) : null}
                      <span title={formatDateTime(entry.updatedAt)}>
                        {formatRelative(entry.updatedAt)}
                      </span>
                    </div>
                  </div>
                  {writable ? (
                    <div className="flex gap-1">
                      {entry.status === 'proposed' ? (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            onPress={() => act(entry, 'accept')}
                            isDisabled={review.isPending}
                          >
                            <Check className="size-3.5" />
                            Accept
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onPress={() => act(entry, 'reject')}
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
                          onPress={() => act(entry, 'accept')}
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
                            onPress={() => act(entry, 'archive')}
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
                        onPress={() => onEdit(entry)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Delete ${entry.title}`}
                        onPress={() => setDeleting(entry)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                <Markdown
                  text={entry.body}
                  className={`text-sm text-muted ${open ? '' : 'line-clamp-3'}`}
                />
                {open ? (
                  <div className="flex flex-col gap-1.5 border-t border-separator pt-2 text-xs text-muted">
                    <span>
                      Tasks: {entry.appliesTo.map(taskLabel).join(', ')}
                      {entry.topics.length ? ` · Topics: ${entry.topics.join(', ')}` : ''}
                    </span>
                    {entry.packages?.length ? (
                      <span className="font-mono">
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
                    <span className="font-mono">kb:{entry.id}</span>
                  </div>
                ) : null}
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this entry?"
        isPending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              notify.success('Entry deleted')
              setDeleting(null)
            },
            onError: (error) => notify.error('Delete failed', messageOf(error)),
          })
        }
      >
        Its history goes too. Archive it instead to keep the record while agents stop reading it.
      </ConfirmDialog>
    </>
  )
}
