import type { ConfigEntryDetail, ConfigEntryView } from '@holtkeeper/api'
import { History, RotateCcw } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useConfigMutations,
  useGroups,
  useJobAnalyzers,
  useSchedulePreview,
} from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  MultiToggle,
  Placeholder,
  TagInput,
  notify,
} from '../../ui/index.ts'

type Provenance = ConfigEntryView['provenance']

/** Where an entry comes from: the config file, the panel, or a panel override of the file. */
export function ProvenanceChip({ provenance }: { provenance: Provenance }) {
  return provenance === 'file' ? (
    <Chip>config file</Chip>
  ) : provenance === 'panel' ? (
    <Chip tone="accent">panel</Chip>
  ) : (
    <Chip tone="warning">overrides file</Chip>
  )
}

/** A labelled read-only value. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  )
}

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

/** A list of short values as chips, or `fallback` when empty. */
export function ChipList({
  values,
  fallback = '—',
}: {
  values: readonly string[]
  fallback?: ReactNode
}) {
  if (values.length === 0) return <span className="text-sm text-muted">{fallback}</span>
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Chip key={value} variant="secondary" className="font-mono">
          {value}
        </Chip>
      ))}
    </span>
  )
}

/** Toggles for the analyzers jobs can run; free text when the server lists none. */
export function AnalyzerPicker({
  label,
  value,
  onChange,
  error,
}: {
  label: string
  value: readonly string[]
  onChange: (value: string[]) => void
  error?: string | undefined
}) {
  const analyzers = useJobAnalyzers()
  const known = analyzers.data?.analyzers ?? []
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
        <TagInput label={label} values={value} onChange={onChange} placeholder="quality" />
      )}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
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
  const ids = [...new Set([...(groups.data?.entries ?? []).map((g) => g.id), ...value])].toSorted()
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">Groups</span>
      {ids.length ? (
        <MultiToggle
          aria-label="Groups"
          options={ids.map((id) => ({ id, label: id }))}
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

/** Earlier panel versions of an entry, newest first, each loadable into the form. */
export function EntryHistory<T extends ConfigEntryView['type']>({
  detail,
  describe,
  onRestore,
}: {
  detail: ConfigEntryDetail<T> | undefined
  describe?: (data: ConfigEntryDetail<T>['history'][number]['data']) => ReactNode
  onRestore: (data: ConfigEntryDetail<T>['history'][number]['data'], version: number) => void
}) {
  const [open, setOpen] = useState(false)
  const history = detail?.history ?? []
  if (history.length === 0) return null
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-separator p-3">
      <button
        type="button"
        className="flex items-center gap-2 text-left text-sm font-medium"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <History className="size-4 text-muted" />
        Earlier versions
        <span className="text-xs text-muted">{history.length}</span>
      </button>
      {open ? (
        <ul className="flex flex-col divide-y divide-separator">
          {history.map((revision) => (
            <li
              key={revision.version}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span className="flex min-w-0 flex-col">
                <span>
                  Version {revision.version}
                  <span className="text-muted" title={formatDateTime(revision.updatedAt)}>
                    {' '}
                    · {formatRelative(revision.updatedAt)}
                    {revision.updatedBy ? ` by ${revision.updatedBy}` : ''}
                  </span>
                </span>
                {describe ? (
                  <span className="truncate text-xs text-muted">{describe(revision.data)}</span>
                ) : null}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onPress={() => onRestore(revision.data, revision.version)}
              >
                <RotateCcw className="size-3.5" />
                Load
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Who changed a panel entry last, e.g. `v3 · 2 hours ago by alice`. */
export function UpdatedLine({ entry }: { entry: ConfigEntryView }) {
  if (entry.version === undefined || !entry.updatedAt) return null
  return (
    <span className="text-xs text-muted" title={formatDateTime(entry.updatedAt)}>
      v{entry.version} · {formatRelative(entry.updatedAt)}
      {entry.updatedBy ? ` by ${entry.updatedBy}` : ''}
    </span>
  )
}

/** Asks before deleting a panel entry or dropping its override of the config file. */
export function RemoveEntryDialog({
  collection,
  entry,
  noun,
  onClose,
}: {
  collection: 'schedules' | 'triggers' | 'repo-traits'
  entry: ConfigEntryView | null
  noun: string
  onClose: () => void
}) {
  const { remove } = useConfigMutations(collection)
  const override = entry?.provenance === 'file+panel'
  return (
    <ConfirmDialog
      isOpen={entry !== null}
      onOpenChange={(open) => !open && onClose()}
      title={
        override
          ? `Revert ${noun} ${entry.id} to the config file?`
          : `Delete ${noun} ${entry?.id ?? ''}?`
      }
      confirmLabel={override ? 'Revert' : 'Delete'}
      isPending={remove.isPending}
      onConfirm={() =>
        entry &&
        remove.mutate(entry.id, {
          onSuccess: () => {
            notify.success(override ? 'Reverted to the config file' : `${noun} deleted`, entry.id)
            onClose()
          },
          onError: (error) => notify.error('Not removed', messageOf(error)),
        })
      }
    >
      {override
        ? 'The panel version and its history are removed; the entry from the config file applies again.'
        : 'The panel version and its history are removed.'}
    </ConfirmDialog>
  )
}

/** The next few run times of a saved schedule. */
export function NextRuns({ id, count = 3 }: { id: string; count?: number }) {
  const preview = useSchedulePreview(id, count)
  if (preview.isPending) return <Placeholder className="h-8 w-28" />
  if (preview.isError)
    return <span className="text-xs text-danger">{messageOf(preview.error)}</span>
  const [first, ...rest] = preview.data.runs
  if (!first) return <span className="text-sm text-muted">None soon</span>
  const now = new Date()
  return (
    <div className="flex flex-col gap-0.5 whitespace-nowrap" title={preview.data.timezone}>
      <span className="text-sm" title={formatDateTime(first)}>
        {formatRelative(first, now)}
      </span>
      {rest.map((run) => (
        <span key={run} className="text-xs text-muted">
          {formatDateTime(run)}
        </span>
      ))}
    </div>
  )
}
