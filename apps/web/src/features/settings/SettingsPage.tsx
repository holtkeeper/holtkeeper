import type {
  ActivityPerson,
  CredentialView,
  SettingDefinitionView,
  SettingView,
} from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useCredentials, useRepos, useSettingMutations, useSettings } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import { editorFor, previewValue } from '../../lib/schema.ts'
import { scopeOrder } from '../../lib/scope.ts'
import {
  Avatar,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Markdown,
  Page,
  Panel,
  Placeholder,
  Tabs,
  notify,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { useSession } from '../shell/session.ts'
import { findCredential } from './CredentialPicker.tsx'
import { EntryDialog } from './EntryDialog.tsx'
import { ResolvePreview } from './ResolvePreview.tsx'

type Editing = { definition: SettingDefinitionView; entry?: SettingView }

const RESOLVE_TAB = 'resolve'

const tabId = (section: string) => section.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')

/** Settings in one tab per section, plus a tab that resolves them for a repository. */
export function SettingsPage() {
  const { can } = useSession()
  const search = useSearch({ from: '/app/settings' })
  const navigate = useNavigate({ from: '/settings' })
  const settings = useSettings()
  const repos = useRepos(can('repos:read'))
  const credentials = useCredentials(can('credentials:read'))
  const { remove } = useSettingMutations()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<{
    definition: SettingDefinitionView
    entry: SettingView
  } | null>(null)
  const writable = can('settings:write')
  const groups = [...new Set((repos.data?.repos ?? []).flatMap((r) => r.groups))].toSorted()

  if (settings.isPending) {
    return (
      <Page title="Settings">
        <Placeholder className="h-10 w-96" />
        <Placeholder className="h-48" />
        <Placeholder className="h-48" />
      </Page>
    )
  }
  if (settings.isError)
    return (
      <Page title="Settings">
        <ErrorState error={settings.error} />
      </Page>
    )

  const { definitions, settings: entries, people } = settings.data
  const sections = [...new Set(definitions.map((d) => d.section))]
  const entriesOf = (definition: SettingDefinitionView) =>
    entries
      .filter((e) => e.key === definition.key)
      .toSorted((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope))
  const tabs = sections.map((section) => {
    const list = definitions.filter((d) => d.section === section)
    const count = list.filter((d) => entriesOf(d).length > 0).length
    return {
      id: tabId(section),
      label: (
        <span className="flex items-center gap-1.5">
          {section}
          {count ? <span className="text-xs text-muted">{count}</span> : null}
        </span>
      ),
      content: (
        <div className="flex flex-col gap-4">
          {list.map((definition) => (
            <SettingCard
              key={definition.key}
              definition={definition}
              entries={entriesOf(definition)}
              credentials={credentials.data?.credentials ?? []}
              people={people}
              writable={writable}
              onAdd={() => setEditing({ definition })}
              onEdit={(entry) => setEditing({ definition, entry })}
              onDelete={(entry) => setDeleting({ definition, entry })}
            />
          ))}
        </div>
      ),
    }
  })
  const selected =
    search.tab && (search.tab === RESOLVE_TAB || tabs.some((t) => t.id === search.tab))
      ? search.tab
      : tabs[0]?.id

  return (
    <Page title="Settings" description="Values per scope; narrower scopes override broader ones">
      {definitions.length === 0 ? (
        <EmptyState icon={<Settings2 />} title="No settings defined" />
      ) : (
        <Tabs
          aria-label="Settings sections"
          {...(selected ? { selected } : {})}
          onSelect={(tab) =>
            void navigate({ search: (previous) => ({ ...previous, tab }), replace: true })
          }
          items={[
            ...tabs,
            {
              id: RESOLVE_TAB,
              label: 'Resolve for repository',
              content: <ResolvePreview definitions={definitions} />,
            },
          ]}
        />
      )}

      {editing ? (
        <EntryDialog
          key={editing.entry?.id ?? editing.definition.key}
          definition={editing.definition}
          {...(editing.entry ? { entry: editing.entry } : {})}
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
          deleting &&
          remove.mutate(deleting.entry.id, {
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
    </Page>
  )
}

/** One setting: its entries per scope on the left, how to set it on the right. */
function SettingCard({
  definition,
  entries,
  credentials,
  people,
  writable,
  onAdd,
  onEdit,
  onDelete,
}: {
  definition: SettingDefinitionView
  entries: SettingView[]
  credentials: readonly CredentialView[]
  people: Readonly<Record<string, ActivityPerson>>
  writable: boolean
  onAdd: () => void
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
          <p className="text-sm text-muted">Not set — the built-in default applies.</p>
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
