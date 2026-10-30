import type { SettingDefinitionView, SettingView } from '@holtkeeper/api'
import { Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useRepos, useSettingMutations, useSettings } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import { previewValue } from '../../lib/schema.ts'
import { scopeOrder } from '../../lib/scope.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  notify,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { useSession } from '../shell/session.ts'
import { EntryDialog } from './EntryDialog.tsx'
import { ResolvePreview } from './ResolvePreview.tsx'

type Editing = { definition: SettingDefinitionView; entry?: SettingView }

/** Settings by section; every key lists its entries per scope. */
export function SettingsPage() {
  const { can } = useSession()
  const settings = useSettings()
  const repos = useRepos(can('repos:read'))
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

  const { definitions, settings: entries } = settings.data
  const sections = [...new Set(definitions.map((d) => d.section))]

  return (
    <Page title="Settings" description="Values per scope; narrower scopes override broader ones">
      {definitions.length === 0 ? (
        <EmptyState icon={<Settings2 />} title="No settings defined" />
      ) : null}
      {sections.map((section) => (
        <section
          key={section}
          className="flex flex-col gap-3"
          aria-labelledby={`section-${section}`}
        >
          <h2
            id={`section-${section}`}
            className="text-sm font-semibold uppercase tracking-wide text-muted"
          >
            {section}
          </h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {definitions
              .filter((d) => d.section === section)
              .map((definition) => {
                const list = entries
                  .filter((e) => e.key === definition.key)
                  .toSorted((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope))
                return (
                  <Panel
                    key={definition.key}
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
                        <Button
                          variant="secondary"
                          size="sm"
                          onPress={() => setEditing({ definition })}
                        >
                          <Plus className="size-3.5" />
                          Add
                        </Button>
                      ) : null
                    }
                  >
                    {list.length === 0 ? (
                      <p className="text-sm text-muted">Not set — the built-in default applies.</p>
                    ) : (
                      <ul className="flex flex-col divide-y divide-separator">
                        <AnimatePresence initial={false}>
                          {list.map((entry) => (
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
                                  previewValue(entry.value, entry.secret)
                                )}
                              </span>
                              <span className="text-xs text-muted">
                                {formatRelative(entry.updatedAt)}
                                {entry.updatedBy ? ` by ${entry.updatedBy}` : ''}
                              </span>
                              {writable ? (
                                <span className="flex gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    isIconOnly
                                    aria-label={`Edit ${definition.label} entry`}
                                    onPress={() => setEditing({ definition, entry })}
                                  >
                                    <Pencil className="size-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    isIconOnly
                                    aria-label={`Delete ${definition.label} entry`}
                                    onPress={() => setDeleting({ definition, entry })}
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
                  </Panel>
                )
              })}
          </div>
        </section>
      ))}

      {definitions.length ? <ResolvePreview definitions={definitions} /> : null}

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
