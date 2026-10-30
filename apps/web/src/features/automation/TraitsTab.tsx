import type { ConfigEntryView } from '@holtkeeper/api'
import { Pencil, Plus, Tags, Trash2, Undo2, X } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useConfigEntries,
  useConfigEntry,
  useConfigMutations,
  useForges,
} from '../../api/queries.ts'
import {
  type TraitRow,
  type TraitType,
  type TraitsDraft,
  formatTraitValue,
  toTraitsDraft,
  toTraitsInput,
  traitsDraftValid,
  traitsId,
  validateTraitsDraft,
} from '../../lib/automation.ts'
import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  ErrorState,
  Notice,
  Panel,
  Placeholder,
  Segmented,
  Select,
  Table,
  Td,
  TextField,
  Th,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { EntryHistory, ProvenanceChip, RemoveEntryDialog, UpdatedLine } from './shared.tsx'

type TraitsEntry = ConfigEntryView<'repoTraits'>

/** Traits per repository path glob, which settings and plugins match on. */
export function TraitsTab() {
  const { can } = useSession()
  const writable = can('settings:write')
  const traits = useConfigEntries('repo-traits')
  const [editing, setEditing] = useState<TraitsEntry | 'new' | null>(null)
  const [removing, setRemoving] = useState<TraitsEntry | null>(null)
  const list = traits.data?.entries ?? []

  return (
    <Panel
      title="Repository traits"
      description="Facts about repositories matched by a path glob, e.g. engine or tier. A panel entry replaces the file entry with the same pattern."
      actions={
        writable ? (
          <Button variant="secondary" size="sm" onPress={() => setEditing('new')}>
            <Plus className="size-4" />
            Add traits
          </Button>
        ) : null
      }
    >
      {traits.isPending ? (
        <Placeholder className="h-32" />
      ) : traits.isError ? (
        <ErrorState error={traits.error} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Tags />}
          title="No repository traits"
          description="Add traits such as engine = unity to games/* and match settings on them."
        />
      ) : (
        <Table label="Repository traits">
          <thead>
            <tr>
              <Th>Pattern</Th>
              <Th>Forge</Th>
              <Th>Traits</Th>
              {writable ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((entry) => {
              const pairs = Object.entries(entry.data.traits).toSorted(([a], [b]) =>
                a.localeCompare(b),
              )
              return (
                <tr key={entry.id}>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px]">{entry.data.pattern}</span>
                        <ProvenanceChip provenance={entry.provenance} />
                      </span>
                      <UpdatedLine entry={entry} />
                    </div>
                  </Td>
                  <Td>{entry.data.forge ?? <span className="text-sm text-muted">Any</span>}</Td>
                  <Td>
                    {pairs.length ? (
                      <span className="flex flex-wrap gap-1">
                        {pairs.map(([key, value]) => (
                          <Chip key={key} variant="secondary" className="font-mono">
                            {key}={formatTraitValue(value)}
                          </Chip>
                        ))}
                      </span>
                    ) : (
                      <span className="text-sm text-muted">—</span>
                    )}
                  </Td>
                  {writable ? (
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          aria-label={`Edit ${entry.data.pattern}`}
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
                                ? `Revert ${entry.data.pattern} to the config file`
                                : `Delete ${entry.data.pattern}`
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
        <TraitsDialog
          key={editing === 'new' ? 'new' : editing.id}
          {...(editing === 'new' ? {} : { entry: editing })}
          takenPatterns={list.map((entry) => entry.data.pattern)}
          takenIds={list.map((entry) => entry.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <RemoveEntryDialog
        collection="repo-traits"
        entry={removing}
        noun="traits"
        onClose={() => setRemoving(null)}
      />
    </Panel>
  )
}

const anyForge = '__any__'

const typeOptions: { id: TraitType; label: string }[] = [
  { id: 'string', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'boolean', label: 'Yes/no' },
]

function TraitsDialog({
  entry,
  takenPatterns,
  takenIds,
  onClose,
}: {
  entry?: TraitsEntry
  takenPatterns: readonly string[]
  takenIds: readonly string[]
  onClose: () => void
}) {
  const isNew = entry === undefined
  const [draft, setDraft] = useState<TraitsDraft>(() => toTraitsDraft(entry?.data))
  const [submitted, setSubmitted] = useState(false)
  const { put } = useConfigMutations('repo-traits')
  const forges = useForges()
  const detail = useConfigEntry('repo-traits', entry?.version === undefined ? undefined : entry.id)
  const errors = submitted ? validateTraitsDraft(draft, isNew ? takenPatterns : []) : {}
  const forgeIds = [
    ...new Set([
      ...(forges.data?.entries ?? []).map((f) => f.id),
      ...(draft.forge ? [draft.forge] : []),
    ]),
  ]

  const updateRow = (index: number, patch: Partial<TraitRow>) =>
    setDraft((d) => ({ ...d, rows: d.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) }))

  const submit = () => {
    setSubmitted(true)
    if (!traitsDraftValid(validateTraitsDraft(draft, isNew ? takenPatterns : []))) return
    const id = entry?.id ?? traitsId(draft.pattern, takenIds)
    put.mutate(
      { id, data: toTraitsInput(draft) },
      {
        onSuccess: () => {
          notify.success(isNew ? 'Traits added' : 'Traits saved', draft.pattern.trim())
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={isNew ? 'Add repository traits' : `Edit traits of ${entry.data.pattern}`}
      description="Every repository whose path matches the pattern gets these traits."
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
        {entry?.provenance === 'file' ? (
          <Notice title="Defined in the config file">
            Saving creates a panel version that replaces it.
          </Notice>
        ) : entry?.provenance === 'file+panel' ? (
          <Notice title="Overrides the config file">
            Reverting removes this panel version and brings back the file traits.
          </Notice>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Path pattern"
            value={draft.pattern}
            onChange={(pattern) => setDraft((d) => ({ ...d, pattern }))}
            error={errors.pattern}
            placeholder="games/*"
            mono
            isRequired
            isDisabled={!isNew}
            autoFocus={isNew}
          />
          <Select
            label="Forge"
            options={[
              { id: anyForge, label: 'Any forge' },
              ...forgeIds.map((id) => ({ id, label: id })),
            ]}
            value={draft.forge || anyForge}
            onChange={(id) => setDraft((d) => ({ ...d, forge: id === anyForge ? '' : id }))}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Traits</span>
            <Button
              variant="ghost"
              size="sm"
              onPress={() =>
                setDraft((d) => ({
                  ...d,
                  rows: [...d.rows, { key: '', type: 'string', value: '' }],
                }))
              }
            >
              <Plus className="size-3.5" />
              Add trait
            </Button>
          </div>
          {draft.rows.length === 0 ? (
            <span className="text-xs text-muted">No traits.</span>
          ) : (
            <ul className="flex flex-col gap-2">
              {draft.rows.map((row, index) => (
                <li key={index} className="flex flex-col gap-1 rounded-xl bg-default/60 p-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <TextField
                      aria-label="Trait name"
                      className="min-w-32 flex-1"
                      value={row.key}
                      onChange={(key) => updateRow(index, { key })}
                      placeholder="engine"
                      mono
                    />
                    <Segmented
                      aria-label="Trait type"
                      options={typeOptions}
                      value={row.type}
                      onChange={(type) =>
                        updateRow(index, {
                          type,
                          ...(type === 'boolean' && row.value !== 'false' ? { value: 'true' } : {}),
                        })
                      }
                    />
                    {row.type === 'boolean' ? (
                      <Segmented
                        aria-label="Trait value"
                        options={[
                          { id: 'true', label: 'true' },
                          { id: 'false', label: 'false' },
                        ]}
                        value={row.value === 'false' ? 'false' : 'true'}
                        onChange={(value) => updateRow(index, { value })}
                      />
                    ) : (
                      <TextField
                        aria-label="Trait value"
                        className="min-w-32 flex-1"
                        type={row.type === 'number' ? 'number' : 'text'}
                        value={row.value}
                        onChange={(value) => updateRow(index, { value })}
                        placeholder={row.type === 'number' ? '2' : 'unity'}
                        mono
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      aria-label={`Remove trait ${row.key || index + 1}`}
                      onPress={() =>
                        setDraft((d) => ({ ...d, rows: d.rows.filter((_, i) => i !== index) }))
                      }
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                  {errors.rows?.[index] ? (
                    <span className="text-xs text-danger">{errors.rows[index]}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <EntryHistory
          detail={detail.data}
          describe={(data) =>
            Object.entries(data.traits)
              .map(([key, value]) => `${key}=${formatTraitValue(value)}`)
              .join(', ')
          }
          onRestore={(data, version) => {
            setDraft(toTraitsDraft(data))
            notify.info(`Version ${version} loaded`, 'Save to apply it.')
          }}
        />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
