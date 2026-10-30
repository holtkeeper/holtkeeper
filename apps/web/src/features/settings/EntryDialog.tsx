import type { Scope, SettingDefinitionView, SettingView } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useSettingMutations } from '../../api/queries.ts'
import { defaultValue, editorFor } from '../../lib/schema.ts'
import { isEmptyScope, normalizeScope } from '../../lib/scope.ts'
import { Button, Dialog, Notice, notify } from '../../ui/index.ts'
import { ScopeEditor } from '../access/ScopeEditor.tsx'
import { ValueEditor } from './ValueEditor.tsx'

/** Creates or replaces one entry of a setting for a scope. */
export function EntryDialog({
  definition,
  entry,
  groups,
  onClose,
}: {
  definition: SettingDefinitionView
  entry?: SettingView
  groups: readonly string[]
  onClose: () => void
}) {
  const editor = editorFor(definition.schema, definition.secret)
  const initial = entry
    ? definition.secret
      ? undefined
      : entry.value
    : definition.secret
      ? undefined
      : defaultValue(definition.schema)
  const [scope, setScope] = useState<Scope>(entry?.scope ?? { all: true })
  const [value, setValue] = useState<unknown>(initial)
  const { put } = useSettingMutations()
  const invalid = value === undefined || isEmptyScope(scope)

  const save = () =>
    put.mutate(
      {
        ...(entry ? { id: entry.id } : {}),
        key: definition.key,
        scope: normalizeScope(scope),
        value,
      },
      {
        onSuccess: () => {
          notify.success('Setting saved', definition.label)
          onClose()
        },
      },
    )

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={`${entry ? 'Edit' : 'Add'} ${definition.label}`}
      description={definition.description}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onPress={save} isDisabled={invalid} isPending={put.isPending}>
            Save
          </Button>
        </>
      }
    >
      {put.error ? (
        <Notice tone="danger" title="Not saved">
          {messageOf(put.error)}
        </Notice>
      ) : null}
      <ScopeEditor value={scope} onChange={setScope} groups={groups} label="Applies to" />
      <ValueEditor
        editor={editor}
        schema={definition.schema}
        initial={value}
        onChange={setValue}
        label="Value"
        hasStoredSecret={entry !== undefined && definition.secret}
      />
    </Dialog>
  )
}
