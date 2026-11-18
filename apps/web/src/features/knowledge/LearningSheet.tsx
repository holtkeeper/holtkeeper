import type { LearningView, PersonView, Scope } from '@holtkeeper/api'
import { Check, ExternalLink, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useLearningMutations, useTeamTitles } from '../../api/queries.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { learningStatusOf, learningTiming, originLabel, sourceLabel } from '../../lib/learnings.ts'
import { agentsLabel, ruleScopeLabel } from '../../lib/rules.ts'
import { ConfirmDialog, KeyValue, SideSheet, Tag, notify } from '../../ui/index.ts'
import { LearningEditor } from './LearningEditor.tsx'
import { Byline } from './parts.tsx'

/** Approve or reject a learning with a toast either way. */
export function useDecideLearning() {
  const { decide } = useLearningMutations()
  const run = (learning: LearningView, decision: 'approve' | 'reject') =>
    decide.mutate(
      { id: learning.id, decision },
      {
        onSuccess: () =>
          notify.success(decision === 'approve' ? 'Approved' : 'Rejected', learning.text),
        onError: (error) => notify.error('Not changed', messageOf(error)),
      },
    )
  return { run, isPending: decide.isPending }
}

/**
 * A learning opened from the Learnings table (`?learning=<id>`): its reason, scope and files, the
 * merge request notes that taught it, how often reviews cited it, votes and when it activates or
 * expires. Approve and Reject for pending ones, Reject for active ones, Edit and Delete for
 * people who may write it. With `creating` it is the form for a new learning instead.
 */
export function LearningSheet({
  learning,
  people,
  creating,
  index,
  total,
  onPrevious,
  onNext,
  onOpen,
  onClose,
}: {
  learning: LearningView | undefined
  people: Readonly<Record<string, PersonView>>
  creating?: Scope
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [editingId, setEditingId] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const { remove } = useLearningMutations()
  const decide = useDecideLearning()
  const titleOf = useTeamTitles()

  if (creating)
    return (
      <SideSheet open onClose={onClose} title="New learning">
        <LearningEditor
          initialScope={creating}
          onSaved={(saved) => onOpen(saved.id)}
          onCancel={onClose}
        />
      </SideSheet>
    )

  const editing = learning !== undefined && editingId === learning.id
  const decisions =
    !learning?.canEdit || editing
      ? []
      : learning.status === 'pending'
        ? [
            { label: 'Approve', icon: Check, onPress: () => decide.run(learning, 'approve') },
            { label: 'Reject', icon: X, onPress: () => decide.run(learning, 'reject') },
          ]
        : learning.status === 'active'
          ? [{ label: 'Reject', icon: X, onPress: () => decide.run(learning, 'reject') }]
          : []
  const status = learning ? learningStatusOf(learning.status) : undefined
  const timing = learning ? learningTiming(learning) : undefined

  return (
    <SideSheet
      open={learning !== undefined}
      onClose={onClose}
      title={learning?.text ?? 'Learning'}
      {...(index !== undefined && total !== undefined ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
      {...(decisions.length
        ? {
            quietActions: decisions.length > 1 ? [decisions[0]!, decisions[1]!] : [decisions[0]!],
          }
        : {})}
      {...(learning?.canEdit && !editing
        ? {
            more: [
              { label: 'Edit', icon: Pencil, onAction: () => setEditingId(learning.id) },
              { label: 'Delete', icon: Trash2, danger: true, onAction: () => setDeleting(true) },
            ],
          }
        : {})}
    >
      {learning && status ? (
        <div key={learning.id} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag tone={status.tone} dot>
              {status.label}
            </Tag>
            {timing ? <Tag tone={timing.soon ? 'warning' : 'default'}>{timing.label}</Tag> : null}
            <Tag>{originLabel(learning.origin)}</Tag>
          </div>
          {editing ? (
            <LearningEditor
              learning={learning}
              onSaved={() => setEditingId(undefined)}
              onCancel={() => setEditingId(undefined)}
            />
          ) : (
            <>
              <KeyValue
                rows={[
                  { label: 'Reason', value: learning.reason || null },
                  {
                    label: 'Scope',
                    value: (
                      <span className="flex flex-wrap items-center gap-1">
                        {ruleScopeLabel(learning.scope, titleOf)}
                        {(learning.files ?? []).map((glob) => (
                          <Tag key={glob} mono>
                            {glob}
                          </Tag>
                        ))}
                      </span>
                    ),
                  },
                  { label: 'Agents', value: agentsLabel(learning.agents) },
                  {
                    label: 'Uses',
                    value: `${plural(learning.uses, 'review comment')} cited it · ${learning.actedOn} ${learning.actedOn === 1 ? 'was' : 'were'} fixed`,
                  },
                  { label: 'Votes', value: `👍 ${learning.votesUp} · 👎 ${learning.votesDown}` },
                  {
                    label: 'Last confirmed',
                    value: (
                      <span title={formatDateTime(learning.lastReinforcedAt)}>
                        {formatRelative(learning.lastReinforcedAt)}
                      </span>
                    ),
                  },
                  {
                    label: 'Cite as',
                    value: <span className="mono">learn:{learning.id}</span>,
                  },
                ]}
              />
              <section className="flex flex-col gap-2 border-t border-line pt-3">
                <h3 className="text-[11.5px] font-medium text-muted">
                  Sources · {learning.sources.length}
                </h3>
                <ul className="flex flex-col gap-1.5 text-[12.5px]">
                  {learning.sources.map((source, position) => (
                    <li
                      // oxlint-disable-next-line react/no-array-index-key
                      key={`${source.noteId ?? source.discussionId ?? source.at}:${position}`}
                      className="flex min-w-0 flex-col gap-0.5"
                    >
                      {source.url ? (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-w-0 items-center gap-1 hover:underline"
                        >
                          <span className="mono truncate">{sourceLabel(source)}</span>
                          <ExternalLink className="size-3 shrink-0 text-muted" />
                        </a>
                      ) : (
                        <span className="mono truncate">{sourceLabel(source)}</span>
                      )}
                      <span className="text-xs text-dim">
                        {source.author ? `${source.author} · ` : ''}
                        {formatRelative(source.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {learning.decidedBy ? (
                  <Byline
                    verb={learning.status === 'rejected' ? 'Rejected' : 'Approved'}
                    id={learning.decidedBy}
                    at={learning.decidedAt}
                    people={people}
                  />
                ) : null}
                {learning.editedBy ? (
                  <Byline
                    verb="Edited"
                    id={learning.editedBy}
                    at={learning.updatedAt}
                    people={people}
                  />
                ) : null}
              </div>
            </>
          )}
          <ConfirmDialog
            isOpen={deleting}
            onOpenChange={setDeleting}
            title="Delete this learning?"
            isPending={remove.isPending}
            onConfirm={() =>
              remove.mutate(learning.id, {
                onSuccess: () => {
                  notify.success('Learning deleted')
                  setDeleting(false)
                  onClose()
                },
                onError: (error) => notify.error('Not deleted', messageOf(error)),
              })
            }
          >
            Reject keeps it so the same rule is not learned again; Delete forgets it.
          </ConfirmDialog>
        </div>
      ) : null}
    </SideSheet>
  )
}
