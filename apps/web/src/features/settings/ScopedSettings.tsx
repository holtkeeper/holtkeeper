import type { SettingDefinitionView, SettingView } from '@holtkeeper/api'
import { Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useCredentials, useSettingMutations, useSettings } from '../../api/queries.ts'
import { inheritedEntry, inheritedFrom, overriddenKeys } from '../../lib/repo-page.ts'
import { editorFor, previewValue } from '../../lib/schema.ts'
import { type ScopeFocus, isSharedScope, namesFocus, scopeOfFocus } from '../../lib/scope.ts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Placeholder,
  Select,
  Table,
  Tag,
  Td,
  Th,
  notify,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { useSession } from '../shell/session.ts'
import { findCredential } from './CredentialPicker.tsx'
import { EntryDialog } from './EntryDialog.tsx'

type Editing = { definition: SettingDefinitionView; entry?: SettingView }

/**
 * The settings made for one repository or group and nothing else: each override with the value it
 * replaces and where that comes from. New overrides start scoped to the focus.
 */
export function ScopedSettings({
  focus,
  groups,
  focusGroups = [],
}: {
  focus: ScopeFocus
  /** Known groups, offered in the scope editor. */
  groups: readonly string[]
  /** Config groups of the repository, to find what its overrides replace. */
  focusGroups?: readonly string[]
}) {
  const { can } = useSession()
  const settings = useSettings()
  const credentials = useCredentials(can('credentials:read'))
  const { remove } = useSettingMutations()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<Editing | null>(null)
  const writable = can('settings:write')
  const here = focus.kind === 'repo' ? 'this repository' : 'this group'

  if (settings.isPending) return <Placeholder className="h-64" />
  if (settings.isError) return <ErrorState error={settings.error} />

  const { definitions, settings: entries } = settings.data
  const overridden = new Set(overriddenKeys(definitions, entries, focus))
  const rows = definitions.filter((definition) => overridden.has(definition.key))
  const addable = definitions.filter((definition) => !overridden.has(definition.key))
  const display = (definition: SettingDefinitionView, entry: SettingView) =>
    entry.secret && entry.value === null
      ? 'set'
      : ((editorFor(definition.schema, definition.secret).kind === 'credential'
          ? findCredential(credentials.data?.credentials ?? [], entry.value)?.name
          : undefined) ?? previewValue(entry.value, entry.secret))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-xs text-muted">
          Only settings made for {here}. Everything else follows its groups or the defaults;
          analyzer options are also edited from each analysis page.
        </p>
        {writable && addable.length ? (
          <Select
            aria-label="Add an override"
            className="w-72"
            placeholder="Add an override…"
            options={addable.map((definition) => ({
              id: definition.key,
              label: definition.label,
              text: definition.label,
            }))}
            value={undefined}
            onChange={(key) => {
              const definition = addable.find((d) => d.key === key)
              if (definition) setEditing({ definition })
            }}
          />
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={<SlidersHorizontal />}
          title="No overrides"
          description={`Nothing is set for ${here} alone.`}
        />
      ) : (
        <section className="rounded-xl border border-line bg-panel">
          <Table label={`Overrides for ${here}`}>
            <thead>
              <tr>
                <Th>Setting</Th>
                <Th>For {here}</Th>
                <Th>Replaces</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((definition) => {
                const own = entries.filter(
                  (e) => e.key === definition.key && namesFocus(e.scope, focus),
                )
                const inherited = inheritedEntry(entries, definition.key, focus, focusGroups)
                return (
                  <tr key={definition.key} className="align-top">
                    <Td>
                      <div className="font-medium" title={definition.key}>
                        {definition.label}
                      </div>
                      <div className="max-w-sm text-xs text-muted">{definition.description}</div>
                    </Td>
                    <Td>
                      <ul className="flex flex-col gap-1">
                        {own.map((entry) => (
                          <li key={entry.id} className="flex items-center gap-1">
                            <span className="mono max-w-64 truncate text-xs">
                              {display(definition, entry)}
                            </span>
                            {isSharedScope(entry.scope) ? <ScopeBadge scope={entry.scope} /> : null}
                            {writable ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  isIconOnly
                                  aria-label={`Edit ${definition.label}`}
                                  onPress={() => setEditing({ definition, entry })}
                                >
                                  <Pencil className="size-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  isIconOnly
                                  aria-label={`Delete ${definition.label}`}
                                  onPress={() => setDeleting({ definition, entry })}
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </Td>
                    <Td>
                      {inherited ? (
                        <div className="flex flex-col items-start gap-1">
                          <span className="mono max-w-64 truncate text-xs text-muted">
                            {display(definition, inherited)}
                          </span>
                          <Tag>inherited from {inheritedFrom(inherited)}</Tag>
                        </div>
                      ) : (
                        <span className="text-xs text-muted">the default</span>
                      )}
                    </Td>
                    <Td align="right">
                      {writable ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onPress={() => setEditing({ definition })}
                        >
                          <Plus className="size-3.5" />
                          Add
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        </section>
      )}

      {editing ? (
        <EntryDialog
          key={editing.entry?.id ?? editing.definition.key}
          definition={editing.definition}
          {...(editing.entry ? { entry: editing.entry } : { initialScope: scopeOfFocus(focus) })}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete this ${deleting?.definition.label ?? 'setting'} entry?`}
        isPending={remove.isPending}
        onConfirm={() =>
          deleting?.entry &&
          remove.mutate(deleting.entry.id, {
            onSuccess: () => {
              notify.success('Entry deleted')
              setDeleting(null)
            },
            onError: (error) => notify.error('Delete failed', messageOf(error)),
          })
        }
      >
        {deleting?.entry && isSharedScope(deleting.entry.scope)
          ? 'The entry also covers other scopes; deleting it removes it for all of them.'
          : focus.kind === 'group'
            ? 'Repositories in this group fall back to broader entries or the default.'
            : 'This repository falls back to broader entries or the default.'}
      </ConfirmDialog>
    </div>
  )
}
