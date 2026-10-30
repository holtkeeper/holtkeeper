import type { Scope, SettingDefinitionView, SettingView } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useSettingMutations } from '../../api/queries.ts'
import { defaultValue, editorFor } from '../../lib/schema.ts'
import { isEmptyScope, normalizeScope } from '../../lib/scope.ts'
import { Button, Dialog, Markdown, Notice, notify } from '../../ui/index.ts'
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
      size="xl"
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
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
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
        </div>
        <SettingHelp definition={definition} />
      </div>
    </Dialog>
  )
}

/** The side column of the editor: what the setting does and how to set it. */
function SettingHelp({ definition }: { definition: SettingDefinitionView }) {
  return (
    <aside className="flex flex-col gap-4 rounded-2xl bg-default/60 p-4 lg:sticky lg:top-0 lg:self-start">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          How to set it
        </span>
        <span className="font-mono text-[11px] text-muted">{definition.key}</span>
      </div>
      <Markdown text={definition.help ?? definition.description} />
      <div className="flex flex-col gap-1.5 border-t border-separator pt-3 text-xs text-muted">
        <span className="font-medium text-foreground">Scopes</span>
        <span>
          Add one entry for all repositories, then narrower entries for groups or repository
          patterns. Usually the most specific entry covering a repository wins; settings that
          combine entries say so above. Check the outcome on the Resolve tab.
        </span>
      </div>
    </aside>
  )
}
