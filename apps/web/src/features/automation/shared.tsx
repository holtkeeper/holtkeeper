import type { ConfigEntryView } from '@holtkeeper/api'
import type { ReactNode } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useConfigMutations,
  useGroups,
  useGroupTitles,
  useJobAnalyzers,
} from '../../api/queries.ts'
import { byGroupTitle } from '../../lib/group-titles.ts'
import { ConfirmDialog, MultiToggle, TagInput, notify } from '../../ui/index.ts'

/** A titled block of a form. */
export function FormSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="text-xs text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

/** Toggles for the analyzers jobs can run; free text when the server lists none. */
export function AnalyzerPicker({
  label,
  value,
  onChange,
  error,
  description,
  readOnly = false,
}: {
  label: string
  value: readonly string[]
  onChange: (value: string[]) => void
  error?: string | undefined
  description?: string
  /** Offer only repository analyzers that do not change repositories. */
  readOnly?: boolean
}) {
  const analyzers = useJobAnalyzers()
  const known = (analyzers.data?.analyzers ?? []).filter(
    (a) => !readOnly || (a.scope === 'repo' && !a.exclusive),
  )
  const options = [
    ...known.map((a) => ({ id: a.kind, label: a.label })),
    ...value
      .filter((kind) => !known.some((a) => a.kind === kind))
      .map((kind) => ({ id: kind, label: kind })),
  ]
  return (
    <div className="flex flex-col gap-1.5">
      {options.length ? (
        <>
          <span className="text-sm font-medium">{label}</span>
          <MultiToggle aria-label={label} options={options} value={value} onChange={onChange} />
        </>
      ) : (
        <TagInput label={label} values={value} onChange={onChange} placeholder="licenses" />
      )}
      {description ? <span className="text-xs text-muted">{description}</span> : null}
      {error ? <span className="text-xs text-bad">{error}</span> : null}
    </div>
  )
}

/** Toggles for config groups; none selected means every group. */
export function GroupPicker({
  value,
  onChange,
  description = 'None selected: every group.',
}: {
  value: readonly string[]
  onChange: (value: string[]) => void
  description?: string
}) {
  const groups = useGroups()
  const titleOf = useGroupTitles()
  const ids = [...new Set([...(groups.data?.entries ?? []).map((g) => g.id), ...value])].toSorted(
    byGroupTitle(titleOf),
  )
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">Groups</span>
      {ids.length ? (
        <MultiToggle
          aria-label="Groups"
          options={ids.map((id) => ({ id, label: titleOf(id) }))}
          value={value}
          onChange={onChange}
        />
      ) : (
        <span className="text-sm text-muted">No groups configured.</span>
      )}
      <span className="text-xs text-muted">{description}</span>
    </div>
  )
}

/** Asks before deleting a panel entry. */
export function RemoveEntryDialog({
  collection,
  entry,
  noun,
  onClose,
  onRemoved,
}: {
  collection: 'schedules' | 'triggers'
  entry: ConfigEntryView | null
  noun: string
  onClose: () => void
  /** Called once it is gone, after `onClose`. */
  onRemoved?: () => void
}) {
  const { remove } = useConfigMutations(collection)
  return (
    <ConfirmDialog
      isOpen={entry !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${noun} ${entry?.id ?? ''}?`}
      confirmLabel="Delete"
      isPending={remove.isPending}
      onConfirm={() =>
        entry &&
        remove.mutate(entry.id, {
          onSuccess: () => {
            notify.success(`${noun} deleted`, entry.id)
            onClose()
            onRemoved?.()
          },
          onError: (error) => notify.error('Not removed', messageOf(error)),
        })
      }
    >
      The {noun} and its history are removed.
    </ConfirmDialog>
  )
}
