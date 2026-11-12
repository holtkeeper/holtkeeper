import type {
  CredentialView,
  PersonView,
  SettingDefinitionView,
  SettingView,
} from '@holtkeeper/api'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'

import { formatRelative } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import { editorFor, previewValue } from '../../lib/schema.ts'
import { Avatar, Button, Chip, Markdown, Panel } from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { findCredential } from './CredentialPicker.tsx'
import { UnknownKeys } from './UnknownKeys.tsx'

/** One setting: its entries per scope on the left, how to set it on the right. */
export function SettingCard({
  definition,
  entries,
  credentials,
  people,
  writable,
  onAdd,
  onEdit,
  onDelete,
  empty = 'Not set — the built-in default applies.',
}: {
  definition: SettingDefinitionView
  entries: SettingView[]
  credentials: readonly CredentialView[]
  people: Readonly<Record<string, PersonView>>
  writable: boolean
  onAdd: () => void
  /** Shown when there are no entries; defaults to the built-in default applying. */
  empty?: string
  onEdit: (entry: SettingView) => void
  onDelete: (entry: SettingView) => void
}) {
  const isCredential = editorFor(definition.schema, definition.secret).kind === 'credential'
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {definition.label}
          {definition.secret ? <Chip tone="warning">secret</Chip> : null}
        </span>
      }
      description={
        <>
          <span className="font-mono text-[11px]">{definition.key}</span>
          <span className="mt-1 block">{definition.description}</span>
        </>
      }
      actions={
        writable ? (
          <Button variant="secondary" size="sm" onPress={onAdd}>
            <Plus className="size-3.5" />
            Add
          </Button>
        ) : null
      }
    >
      <div className={`grid gap-4 ${definition.help ? 'lg:grid-cols-[minmax(0,1fr)_22rem]' : ''}`}>
        {entries.length === 0 ? (
          <p className="text-sm text-muted">{empty}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y divide-separator">
            <AnimatePresence initial={false}>
              {entries.map((entry) => (
                <motion.li
                  key={entry.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
                >
                  <ScopeBadge scope={entry.scope} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {entry.secret && entry.value === null ? (
                      <Chip tone="success">set</Chip>
                    ) : (
                      ((isCredential
                        ? findCredential(credentials, entry.value)?.name
                        : undefined) ?? previewValue(entry.value, entry.secret))
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    {formatRelative(entry.updatedAt)}
                    {entry.updatedBy ? (
                      <UpdatedBy person={personOf(people, entry.updatedBy)} />
                    ) : null}
                  </span>
                  {writable ? (
                    <span className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Edit ${definition.label} entry`}
                        onPress={() => onEdit(entry)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Delete ${definition.label} entry`}
                        onPress={() => onDelete(entry)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </span>
                  ) : null}
                  <UnknownKeys keys={entry.unknownKeys} className="basis-full" />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
        {definition.help ? (
          <Markdown
            text={definition.help}
            className="rounded-xl bg-default/60 p-3 text-xs! text-muted"
          />
        ) : null}
      </div>
    </Panel>
  )
}

function UpdatedBy({ person }: { person: ReturnType<typeof personOf> }) {
  return (
    <>
      by
      <Avatar src={person.avatarUrl} name={person.name} size="xs" />
      <span className={person.known ? 'font-medium text-foreground' : 'font-mono'}>
        {person.name}
      </span>
    </>
  )
}
