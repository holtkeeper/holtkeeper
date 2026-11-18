import type { RuleView, Scope } from '@holtkeeper/api'
import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useRule, useRuleMutations, useTeamTitles } from '../../api/queries.ts'
import {
  activationLabels,
  activationOf,
  agentsLabel,
  restoreRuleInput,
  ruleScopeLabel,
  ruleVersions,
} from '../../lib/rules.ts'
import {
  Button,
  ConfirmDialog,
  ErrorState,
  KeyValue,
  Markdown,
  Placeholder,
  SideSheet,
  Tag,
  notify,
} from '../../ui/index.ts'
import { Byline } from './parts.tsx'
import { RuleEditor } from './RuleEditor.tsx'

const noPeople = {}

/**
 * A rule opened from the Rules list (`?rule=<id>`): its text and where it applies, its earlier
 * versions with Restore, Edit and Delete for people who may write it. With `creating` it is the
 * form for a new rule instead.
 */
export function RuleSheet({
  rule,
  creating,
  index,
  total,
  onPrevious,
  onNext,
  onOpen,
  onClose,
}: {
  rule: RuleView | undefined
  /** Scope a new rule starts with; set while the form for a new rule is open. */
  creating?: Scope
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'rule' | 'history'>('rule')
  const [editing, setEditing] = useState<{ id: string; generation: number }>()
  const [deleting, setDeleting] = useState(false)
  const { remove } = useRuleMutations()
  const detail = useRule(rule?.id)
  const titleOf = useTeamTitles()

  if (creating)
    return (
      <SideSheet open onClose={onClose} title="New rule">
        <RuleEditor
          initialScope={creating}
          onSaved={(saved) => onOpen(saved.id)}
          onCancel={onClose}
        />
      </SideSheet>
    )

  const current = detail.data?.rule ?? rule
  const isEditing = current !== undefined && editing?.id === current.id
  const history = detail.data?.history ?? []

  return (
    <SideSheet
      open={rule !== undefined}
      onClose={onClose}
      title={current?.title ?? 'Rule'}
      {...(index !== undefined && total !== undefined ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
      {...(current?.canEdit && !isEditing
        ? {
            more: [
              {
                label: 'Edit',
                icon: Pencil,
                onAction: () => {
                  setTab('rule')
                  setEditing({ id: current.id, generation: 0 })
                },
              },
              { label: 'Delete', icon: Trash2, danger: true, onAction: () => setDeleting(true) },
            ],
          }
        : {})}
      tabs={{
        'aria-label': 'Rule details',
        selected: tab,
        onSelect: (id) => setTab(id === 'history' ? 'history' : 'rule'),
        items: [
          { id: 'rule', label: 'Rule' },
          { id: 'history', label: 'History', badge: current ? current.version : undefined },
        ],
      }}
    >
      {current ? (
        <div key={current.id} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag mono>Version {current.version}</Tag>
            <Tag tone={activationOf(current) === 'requested' ? 'info' : 'default'}>
              {activationLabels[activationOf(current)]}
            </Tag>
          </div>
          {tab === 'rule' ? (
            isEditing ? (
              <RuleEditor
                key={`${current.version}:${editing.generation}`}
                rule={current}
                onSaved={() => setEditing(undefined)}
                onCancel={() => setEditing(undefined)}
                onReload={() =>
                  void detail
                    .refetch()
                    .then(() => setEditing({ id: current.id, generation: editing.generation + 1 }))
                }
              />
            ) : (
              <div className="flex flex-col gap-4">
                <Markdown text={current.body} className="text-[13px]" />
                <section className="flex flex-col gap-2.5 border-t border-line pt-3">
                  <h3 className="text-[11.5px] font-medium text-muted">Where it applies</h3>
                  <KeyValue
                    rows={[
                      { label: 'Scope', value: ruleScopeLabel(current.scope, titleOf) },
                      {
                        label: 'Files',
                        value: current.files?.length ? (
                          <span className="flex flex-wrap gap-1">
                            {current.files.map((glob) => (
                              <Tag key={glob} mono>
                                {glob}
                              </Tag>
                            ))}
                          </span>
                        ) : null,
                      },
                      { label: 'Agents', value: agentsLabel(current.agents) },
                      { label: 'Description', value: current.description || null },
                      {
                        label: 'Always apply',
                        value: current.description ? (current.alwaysApply ? 'Yes' : 'No') : null,
                      },
                      { label: 'Cite as', value: <span className="mono">rule:{current.id}</span> },
                    ]}
                  />
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <Byline
                      verb="Written"
                      id={current.author}
                      at={current.createdAt}
                      people={noPeople}
                    />
                    {current.updatedBy ? (
                      <Byline
                        verb="edited"
                        id={current.updatedBy}
                        at={current.updatedAt}
                        people={noPeople}
                      />
                    ) : null}
                  </div>
                </section>
              </div>
            )
          ) : (
            <RuleHistory rule={current} history={history} detail={detail} />
          )}
          <ConfirmDialog
            isOpen={deleting}
            onOpenChange={setDeleting}
            title="Delete this rule?"
            isPending={remove.isPending}
            onConfirm={() =>
              remove.mutate(current.id, {
                onSuccess: () => {
                  notify.success('Rule deleted', current.title)
                  setDeleting(false)
                  onClose()
                },
                onError: (error) => notify.error('Not deleted', messageOf(error)),
              })
            }
          >
            Agents stop reading it at once, and its history goes too.
          </ConfirmDialog>
        </div>
      ) : null}
    </SideSheet>
  )
}

function RuleHistory({
  rule,
  history,
  detail,
}: {
  rule: RuleView
  history: NonNullable<ReturnType<typeof useRule>['data']>['history']
  detail: ReturnType<typeof useRule>
}) {
  const { update } = useRuleMutations()
  if (detail.isPending) return <Placeholder className="h-24" />
  if (detail.isError) return <ErrorState error={detail.error} />
  return (
    <ol className="flex flex-col">
      {ruleVersions(rule, history).map((row) => (
        <li
          key={row.version}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2.5 border-t border-line py-2.5 text-[12.5px] first:border-t-0 first:pt-0.5"
        >
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="mono">v{row.version}</span>
            <Byline
              verb={row.version === 1 ? 'written' : 'saved'}
              id={row.by}
              at={row.at}
              people={noPeople}
            />
          </span>
          {row.current ? (
            <Tag>Current</Tag>
          ) : rule.canEdit && row.revision ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={update.isPending}
              onPress={() =>
                row.revision &&
                update.mutate(
                  { id: rule.id, input: restoreRuleInput(rule, row.revision) },
                  {
                    onSuccess: () => notify.success(`Restored v${row.version}`, rule.title),
                    onError: (error) => notify.error('Not restored', messageOf(error)),
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
