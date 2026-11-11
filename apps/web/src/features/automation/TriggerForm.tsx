import type { ConfigEntryView } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useConfigMutations, useJobAnalyzers, useRunNewRepoTrigger } from '../../api/queries.ts'
import {
  type TriggerDraft,
  mergeRequestActions,
  toTriggerDraft,
  toTriggerInput,
  triggerId,
  triggerKinds,
  validateTriggerDraft,
} from '../../lib/automation.ts'
import {
  Button,
  MultiToggle,
  Notice,
  Segmented,
  Select,
  Switch,
  TagInput,
  TextField,
  notify,
} from '../../ui/index.ts'
import { RuleForm } from './RuleForm.tsx'
import { AnalyzerPicker, GroupPicker, RemoveEntryDialog } from './shared.tsx'

const actionLabels = { open: 'Opened', update: 'New commits', reopen: 'Reopened' } as const

/**
 * Edits an event trigger in the rule drawer, or adds one when `entry` is absent. Each kind has a
 * fixed id, so label and command triggers keep their label or command once saved.
 */
export function TriggerForm({
  entry,
  taken,
  writable,
  onDone,
}: {
  entry?: ConfigEntryView<'trigger'>
  /** Ids of existing triggers a new one must not reuse. */
  taken: readonly string[]
  writable: boolean
  onDone: () => void
}) {
  const isNew = entry === undefined
  const [draft, setDraft] = useState<TriggerDraft>(() => toTriggerDraft(entry?.data))
  const [submitted, setSubmitted] = useState(false)
  const [removing, setRemoving] = useState(false)
  const { put } = useConfigMutations('triggers')
  const analyzers = useJobAnalyzers()
  const backfill = useRunNewRepoTrigger()
  const errors = submitted ? validateTriggerDraft(draft, isNew ? taken : []) : {}
  const set = <K extends keyof TriggerDraft>(key: K, value: TriggerDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const grouped = draft.on !== 'label' && draft.on !== 'command'

  const save = () => {
    setSubmitted(true)
    if (Object.keys(validateTriggerDraft(draft, isNew ? taken : [])).length) return
    const data = toTriggerInput(draft)
    const id = entry?.id ?? triggerId(data)
    put.mutate(
      { id, data },
      {
        onSuccess: () => {
          notify.success(isNew ? 'Trigger added' : 'Trigger saved', id)
          onDone()
        },
      },
    )
  }

  const analyzerOptions = [
    ...(analyzers.data?.analyzers ?? []).map((a) => ({ id: a.kind, label: a.label })),
    ...(draft.analyzer && !analyzers.data?.analyzers.some((a) => a.kind === draft.analyzer)
      ? [{ id: draft.analyzer, label: draft.analyzer }]
      : []),
  ]

  return (
    <>
      <RuleForm
        writable={writable}
        isPending={put.isPending}
        onSave={save}
        {...(entry ? { onRemove: () => setRemoving(true) } : {})}
        notice={
          put.error ? (
            <Notice tone="danger" title="Not saved">
              {messageOf(put.error)}
            </Notice>
          ) : errors.id ? (
            <Notice tone="warning" title="Already configured">
              {errors.id}
            </Notice>
          ) : null
        }
        when={
          <>
            {isNew ? (
              <Segmented
                aria-label="Event"
                options={triggerKinds}
                value={draft.on}
                onChange={(v) => set('on', v)}
              />
            ) : (
              <span className="text-sm">{triggerKinds.find((k) => k.id === draft.on)?.label}</span>
            )}
            {draft.on === 'label' ? (
              <TextField
                label="Label"
                value={draft.label}
                onChange={(v) => set('label', v)}
                error={errors.label}
                placeholder="needs-check"
                isRequired
                isDisabled={!isNew}
                description="Added to a merge request, drafts included."
              />
            ) : null}
            {draft.on === 'command' ? (
              <TextField
                label="Command"
                value={draft.command}
                onChange={(v) => set('command', v)}
                error={errors.command}
                placeholder="check"
                mono
                isRequired
                isDisabled={!isNew}
                description={`A merge request comment: /holtkeeper ${draft.command.trim() || '<command>'} [args]`}
              />
            ) : null}
          </>
        }
        where={
          grouped ? (
            <GroupPicker
              value={draft.groups}
              onChange={(v) => set('groups', v)}
              description="None selected: every repository."
            />
          ) : (
            <p className="text-sm text-muted">Any repository the event comes from.</p>
          )
        }
        condition={
          draft.on === 'mergeRequest' ? (
            <>
              <MultiToggle
                aria-label="Merge request events"
                options={mergeRequestActions.map((id) => ({ id, label: actionLabels[id] }))}
                value={draft.actions.length ? draft.actions : mergeRequestActions}
                onChange={(v) => set('actions', v)}
              />
              <Switch
                label="Include drafts"
                isSelected={draft.draft}
                onChange={(v) => set('draft', v)}
              />
            </>
          ) : draft.on === 'push' ? (
            <TagInput
              label="Branches"
              values={draft.branches}
              onChange={(v) => set('branches', v)}
              placeholder="main"
              description="Globs such as main or release/*. None: every branch."
            />
          ) : draft.on === 'command' ? (
            <TagInput
              label="Positional arguments"
              values={draft.args}
              onChange={(v) => set('args', v)}
              placeholder="targets"
              description="Option names filled in order; the last one takes the rest as a list."
            />
          ) : undefined
        }
        then={
          draft.on === 'command' ? (
            <div className="flex flex-col gap-1">
              <Select
                label="Analyzer"
                options={analyzerOptions}
                value={draft.analyzer || undefined}
                onChange={(v) => set('analyzer', v)}
                placeholder="Choose an analyzer"
              />
              {errors.analyzer ? (
                <span className="text-xs text-danger">{errors.analyzer}</span>
              ) : null}
            </div>
          ) : draft.on === 'newRepo' ? (
            <>
              <AnalyzerPicker
                label="Analyzers"
                value={draft.analyzers}
                onChange={(v) => set('analyzers', v)}
                readOnly
                description="None selected: every analyzer that only reads."
              />
              {draft.analyzers.length === 0 ? (
                <AnalyzerPicker
                  label="Except"
                  value={draft.exclude}
                  onChange={(v) => set('exclude', v)}
                  readOnly
                />
              ) : null}
            </>
          ) : (
            <AnalyzerPicker
              label="Analyzers"
              value={draft.analyzers}
              onChange={(v) => set('analyzers', v)}
              error={errors.analyzers}
            />
          )
        }
        limits={
          draft.on === 'newRepo' && !isNew ? (
            <Button
              variant="secondary"
              size="sm"
              isPending={backfill.isPending}
              onPress={() =>
                backfill.mutate(undefined, {
                  onSuccess: () => notify.success('Started on every known repository'),
                  onError: (error) => notify.error('Not started', messageOf(error)),
                })
              }
            >
              Run on every known repository
            </Button>
          ) : (
            <p className="text-sm text-muted">
              A job already queued for the same ref is not queued again
              {draft.on === 'push' ? '; a newer push cancels queued jobs of its branch' : ''}.
            </p>
          )
        }
      />
      <RemoveEntryDialog
        collection="triggers"
        entry={removing && entry ? entry : null}
        noun="trigger"
        onClose={() => setRemoving(false)}
        onRemoved={onDone}
      />
    </>
  )
}
