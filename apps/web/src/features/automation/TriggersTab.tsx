import type { ConfigEntryView } from '@holtkeeper/api'
import { Pencil, Plus, Trash2, Undo2, Zap } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useConfigEntries,
  useConfigEntry,
  useConfigMutations,
  useJobAnalyzers,
} from '../../api/queries.ts'
import {
  type TriggerDraft,
  type TriggerKind,
  describeTrigger,
  mergeRequestActions,
  toTriggerDraft,
  toTriggerInput,
  triggerAnalyzers,
  triggerId,
  triggerKinds,
  validateTriggerDraft,
} from '../../lib/automation.ts'
import { formatGroupMatch } from '../../lib/scope.ts'
import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  ErrorState,
  MultiToggle,
  Notice,
  Panel,
  Placeholder,
  Segmented,
  Select,
  Switch,
  Table,
  TagInput,
  Td,
  TextField,
  Th,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import {
  AnalyzerPicker,
  ChipList,
  EntryHistory,
  FormSection,
  GroupPicker,
  ProvenanceChip,
  RemoveEntryDialog,
  UpdatedLine,
} from './shared.tsx'

type TriggerEntry = ConfigEntryView<'trigger'>

const kindLabel = (kind: TriggerKind) => triggerKinds.find((k) => k.id === kind)?.label ?? kind

/** Event triggers of the effective config: tags, merge requests, labels and comment commands. */
export function TriggersTab() {
  const { can } = useSession()
  const writable = can('settings:write')
  const triggers = useConfigEntries('triggers')
  const [editing, setEditing] = useState<TriggerEntry | 'new' | null>(null)
  const [removing, setRemoving] = useState<TriggerEntry | null>(null)
  const list = triggers.data?.entries ?? []

  return (
    <Panel
      title="Triggers"
      description="Analyzers queued when the forge reports an event through a webhook or polling. A panel trigger replaces the file trigger with the same id."
      actions={
        writable ? (
          <Button variant="secondary" size="sm" onPress={() => setEditing('new')}>
            <Plus className="size-4" />
            Add trigger
          </Button>
        ) : null
      }
    >
      {triggers.isPending ? (
        <Placeholder className="h-32" />
      ) : triggers.isError ? (
        <ErrorState error={triggers.error} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Zap />}
          title="No triggers"
          description="Review merge requests as they open, write changelogs on tags or add /holtkeeper commands."
        />
      ) : (
        <Table label="Triggers">
          <thead>
            <tr>
              <Th>Trigger</Th>
              <Th>When</Th>
              <Th>Analyzers</Th>
              <Th>Groups</Th>
              {writable ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((entry) => {
              const groups =
                entry.data.on === 'tag' ||
                entry.data.on === 'push' ||
                entry.data.on === 'mergeRequest'
                  ? (entry.data.groups ?? [])
                  : undefined
              return (
                <tr key={entry.id}>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {kindLabel(entry.data.on)}
                        <ProvenanceChip provenance={entry.provenance} />
                      </span>
                      <span className="font-mono text-xs text-muted">{entry.id}</span>
                      <UpdatedLine entry={entry} />
                    </div>
                  </Td>
                  <Td>
                    <span className={entry.data.on === 'command' ? 'font-mono text-xs' : 'text-sm'}>
                      {describeTrigger(entry.data)}
                    </span>
                  </Td>
                  <Td>
                    <ChipList values={triggerAnalyzers(entry.data)} />
                  </Td>
                  <Td>
                    {groups === undefined ? (
                      <span className="text-sm text-muted">—</span>
                    ) : groups.length ? (
                      <span className="text-sm">{groups.map(formatGroupMatch).join(', ')}</span>
                    ) : (
                      <span className="text-sm text-muted">All groups</span>
                    )}
                  </Td>
                  {writable ? (
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          aria-label={`Edit ${entry.id}`}
                          onPress={() => setEditing(entry)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        {entry.provenance !== 'file' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            isIconOnly
                            aria-label={
                              entry.provenance === 'file+panel'
                                ? `Revert ${entry.id} to the config file`
                                : `Delete ${entry.id}`
                            }
                            onPress={() => setRemoving(entry)}
                          >
                            {entry.provenance === 'file+panel' ? (
                              <Undo2 className="size-3.5" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                          </Button>
                        ) : null}
                      </div>
                    </Td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </Table>
      )}

      {editing ? (
        <TriggerDialog
          key={editing === 'new' ? 'new' : editing.id}
          {...(editing === 'new' ? {} : { entry: editing })}
          taken={list.map((entry) => entry.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <RemoveEntryDialog
        collection="triggers"
        entry={removing}
        noun="trigger"
        onClose={() => setRemoving(null)}
      />
    </Panel>
  )
}

const actionLabels = { open: 'Opened', update: 'New commits', reopen: 'Reopened' } as const

function TriggerDialog({
  entry,
  taken,
  onClose,
}: {
  entry?: TriggerEntry
  taken: readonly string[]
  onClose: () => void
}) {
  const isNew = entry === undefined
  const [draft, setDraft] = useState<TriggerDraft>(() => toTriggerDraft(entry?.data))
  const [submitted, setSubmitted] = useState(false)
  const { put } = useConfigMutations('triggers')
  const analyzers = useJobAnalyzers()
  const detail = useConfigEntry('triggers', entry?.version === undefined ? undefined : entry.id)
  const errors = submitted ? validateTriggerDraft(draft, isNew ? taken : []) : {}
  const set = <K extends keyof TriggerDraft>(key: K, value: TriggerDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const submit = () => {
    setSubmitted(true)
    if (Object.keys(validateTriggerDraft(draft, isNew ? taken : [])).length) return
    const data = toTriggerInput(draft)
    const id = entry?.id ?? triggerId(data)
    put.mutate(
      { id, data },
      {
        onSuccess: () => {
          notify.success(isNew ? 'Trigger added' : 'Trigger saved', id)
          onClose()
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
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={isNew ? 'Add trigger' : `Edit ${entry.id}`}
      description="Each kind has a fixed id, so there is one tag and one merge request trigger, one per label and one per command."
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onPress={submit} isPending={put.isPending}>
            {isNew ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {put.error ? (
          <Notice tone="danger" title="Not saved">
            {messageOf(put.error)}
          </Notice>
        ) : null}
        {errors.id ? (
          <Notice tone="warning" title="Already configured">
            {errors.id}
          </Notice>
        ) : null}
        {entry?.provenance === 'file' ? (
          <Notice title="Defined in the config file">
            Saving creates a panel version that replaces it.
          </Notice>
        ) : entry?.provenance === 'file+panel' ? (
          <Notice title="Overrides the config file">
            Reverting removes this panel version and brings back the file trigger.
          </Notice>
        ) : null}

        {isNew ? (
          <Segmented
            aria-label="Trigger kind"
            options={triggerKinds}
            value={draft.on}
            onChange={(v) => set('on', v)}
          />
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <Chip variant="secondary">{kindLabel(draft.on)}</Chip>
          </div>
        )}

        {draft.on === 'label' ? (
          <TextField
            label="Label"
            value={draft.label}
            onChange={(v) => set('label', v)}
            error={errors.label}
            placeholder="needs-port"
            isRequired
            isDisabled={!isNew}
            description="Queues the analyzers when the label is added to a merge request, drafts included."
          />
        ) : null}

        {draft.on === 'command' ? (
          <>
            <TextField
              label="Command"
              value={draft.command}
              onChange={(v) => set('command', v)}
              error={errors.command}
              placeholder="port"
              mono
              isRequired
              isDisabled={!isNew}
              description={`Run from a merge request comment: /holtkeeper ${draft.command.trim() || '<command>'} [args]`}
            />
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
            <TagInput
              label="Positional arguments"
              values={draft.args}
              onChange={(v) => set('args', v)}
              placeholder="targets"
              description="Option names filled in order; the last one takes the rest as a list. key=value arguments always work."
            />
          </>
        ) : (
          <AnalyzerPicker
            label="Analyzers"
            value={draft.analyzers}
            onChange={(v) => set('analyzers', v)}
            error={errors.analyzers}
          />
        )}

        {draft.on === 'mergeRequest' ? (
          <FormSection title="Merge request events">
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
          </FormSection>
        ) : null}

        {draft.on === 'push' ? (
          <TagInput
            label="Branches"
            values={draft.branches}
            onChange={(v) => set('branches', v)}
            placeholder="main"
            description="Globs such as main or release/*; ** matches names with slashes. None: every branch. A newer push cancels queued jobs of the same branch."
          />
        ) : null}

        {draft.on === 'tag' || draft.on === 'push' || draft.on === 'mergeRequest' ? (
          <GroupPicker
            value={draft.groups}
            onChange={(v) => set('groups', v)}
            description="None selected: every repository."
          />
        ) : null}

        <EntryHistory
          detail={detail.data}
          describe={(data) => `${describeTrigger(data)} · ${triggerAnalyzers(data).join(', ')}`}
          onRestore={(data, version) => {
            setDraft(toTriggerDraft(data))
            notify.info(`Version ${version} loaded`, 'Save to apply it.')
          }}
        />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
