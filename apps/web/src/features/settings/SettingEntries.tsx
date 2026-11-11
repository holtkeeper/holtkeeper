import type { Scope, SettingDefinitionView, SettingList, SettingView } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useCredentials, useRepos, useSettingMutations } from '../../api/queries.ts'
import { scopeOrder } from '../../lib/scope.ts'
import { ConfirmDialog, notify } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { EntryDialog } from './EntryDialog.tsx'
import { SettingCard } from './SettingCard.tsx'

/** One setting's entries with the setting's own editor for adding, editing and deleting them. */
export function SettingEntries({
  data,
  definition,
  entries = data.settings.filter((entry) => entry.key === definition.key),
  initialScope,
  empty,
}: {
  data: SettingList
  definition: SettingDefinitionView
  /** Defaults to every entry of the setting the caller may read. */
  entries?: SettingView[]
  initialScope?: Scope
  empty?: string
}) {
  const { can } = useSession()
  const repos = useRepos(can('repos:read'))
  const credentials = useCredentials(can('credentials:read'))
  const { remove } = useSettingMutations()
  const [editing, setEditing] = useState<SettingView | 'new' | null>(null)
  const [deleting, setDeleting] = useState<SettingView | null>(null)
  const groups = [...new Set((repos.data?.repos ?? []).flatMap((r) => r.groups))].toSorted()

  return (
    <>
      <SettingCard
        definition={definition}
        entries={entries.toSorted((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope))}
        credentials={credentials.data?.credentials ?? []}
        people={data.people}
        writable={can('settings:write')}
        {...(empty ? { empty } : {})}
        onAdd={() => setEditing('new')}
        onEdit={setEditing}
        onDelete={setDeleting}
      />
      {editing ? (
        <EntryDialog
          key={editing === 'new' ? 'new' : editing.id}
          definition={definition}
          {...(editing === 'new' ? (initialScope ? { initialScope } : {}) : { entry: editing })}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete this ${definition.label} entry?`}
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
        Repositories it covered fall back to broader entries or the default.
      </ConfirmDialog>
    </>
  )
}
