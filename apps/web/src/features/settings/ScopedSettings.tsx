import type { SettingDefinitionView, SettingView } from '@holtkeeper/api'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useCredentials,
  useResolvedSettings,
  useSettingMutations,
  useSettings,
} from '../../api/queries.ts'
import { editorFor, previewValue } from '../../lib/schema.ts'
import { type ScopeFocus, isSharedScope, namesFocus, scopeOfFocus } from '../../lib/scope.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  ErrorState,
  Panel,
  Placeholder,
  Table,
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
 * Every setting as it applies to one repository or group: entries made for it, and for a
 * repository the value that wins from broader scopes. New entries start scoped to the focus.
 */
export function ScopedSettings({
  focus,
  groups,
}: {
  focus: ScopeFocus
  /** Known groups, offered in the scope editor. */
  groups: readonly string[]
}) {
  const { can } = useSession()
  const settings = useSettings()
  const resolved = useResolvedSettings(focus.kind === 'repo' ? focus.repo : undefined)
  const credentials = useCredentials(can('credentials:read'))
  const { remove } = useSettingMutations()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<Editing | null>(null)
  const writable = can('settings:write')
  const here = focus.kind === 'repo' ? 'this repository' : 'this group'

  if (settings.isPending) return <Placeholder className="h-64" />
  if (settings.isError) return <ErrorState error={settings.error} />

  const { definitions, settings: entries } = settings.data
  const sections = [...new Set(definitions.map((d) => d.section))]
  const display = (definition: SettingDefinitionView, entry: SettingView) =>
    entry.secret && entry.value === null
      ? 'set'
      : ((editorFor(definition.schema, definition.secret).kind === 'credential'
          ? findCredential(credentials.data?.credentials ?? [], entry.value)?.name
          : undefined) ?? previewValue(entry.value, entry.secret))

  return (
    <div className="flex flex-col gap-4">
      {sections.map((section) => (
        <Panel key={section} title={section} contentClassName="p-0 sm:p-2">
          <Table label={`${section} settings`}>
            <thead>
              <tr>
                <Th>Setting</Th>
                <Th>For {here}</Th>
                {focus.kind === 'repo' ? <Th>Effective</Th> : null}
                <Th />
              </tr>
            </thead>
            <tbody>
              {definitions
                .filter((d) => d.section === section)
                .map((definition) => {
                  const own = entries.filter(
                    (e) => e.key === definition.key && namesFocus(e.scope, focus),
                  )
                  const winner =
                    focus.kind === 'repo' ? resolved.data?.settings[definition.key] : undefined
                  return (
                    <tr key={definition.key} className="align-top">
                      <Td>
                        <div className="font-medium">{definition.label}</div>
                        <div className="max-w-sm text-xs text-muted">{definition.description}</div>
                      </Td>
                      <Td>
                        {own.length === 0 ? (
                          <span className="text-xs text-muted">—</span>
                        ) : (
                          <ul className="flex flex-col gap-1">
                            {own.map((entry) => (
                              <li key={entry.id} className="flex items-center gap-1">
                                <span className="max-w-64 truncate font-mono text-xs">
                                  {display(definition, entry)}
                                </span>
                                {isSharedScope(entry.scope) ? (
                                  <ScopeBadge scope={entry.scope} />
                                ) : null}
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
                        )}
                      </Td>
                      {focus.kind === 'repo' ? (
                        <Td>
                          {winner ? (
                            <div className="flex flex-col items-start gap-1">
                              <span className="max-w-64 truncate font-mono text-xs">
                                {display(definition, winner)}
                              </span>
                              {namesFocus(winner.scope, focus) ? (
                                <Chip tone="accent">this repository</Chip>
                              ) : (
                                <ScopeBadge scope={winner.scope} />
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted">default</span>
                          )}
                        </Td>
                      ) : null}
                      <Td align="right">
                        {writable ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onPress={() => setEditing({ definition })}
                          >
                            <Plus className="size-3.5" />
                            {own.length ? 'Add' : 'Set here'}
                          </Button>
                        ) : null}
                      </Td>
                    </tr>
                  )
                })}
            </tbody>
          </Table>
        </Panel>
      ))}

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
