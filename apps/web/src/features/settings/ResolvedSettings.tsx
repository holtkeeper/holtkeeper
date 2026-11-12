import type {
  ResolvedSettingRow,
  SettingDefinitionView,
  SettingLayer,
  SettingView,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useCredentials,
  useGroups,
  useGroupTitles,
  useRepos,
  useResolvedScope,
  useSettingMutations,
  useSettings,
} from '../../api/queries.ts'
import { visibleSettingsSections } from '../../lib/access.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import {
  type OrgSettingRow,
  type ResolvedFilter,
  type ResolvedSection,
  layerCounts,
  parentGroupCount,
  orgRowMatches,
  orgRows,
  resolvedSections,
  rowMatches,
  setHere,
  sourceLabel,
} from '../../lib/resolved-settings.ts'
import { editorFor, previewValue } from '../../lib/schema.ts'
import { type ScopeFocus, focusParent, isSharedScope, scopeOfFocus } from '../../lib/scope.ts'
import {
  type SettingsSectionId,
  definitionsOf,
  sectionDefinitions,
  settingAnchor,
  settingHome,
  settingsPageHomes,
  settingsSections,
} from '../../lib/settings-sections.ts'
import {
  Button,
  ConfirmDialog,
  Count,
  EmptyState,
  ErrorState,
  LinkButton,
  Placeholder,
  SearchInput,
  Segmented,
  Select,
  Table,
  Tag,
  Td,
  Th,
  Tr,
  notify,
} from '../../ui/index.ts'
import { RepoUpdatesSection } from '../repos/RepoUpdates.tsx'
import { useSession } from '../shell/session.ts'
import { findCredential } from './CredentialPicker.tsx'
import { EntryDialog } from './EntryDialog.tsx'
import { ValueEditor } from './ValueEditor.tsx'

type Editing = { definition: SettingDefinitionView; entry?: SettingView }

const UPDATES = 'updates'

const filters: { id: ResolvedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'here', label: 'Overridden here' },
  { id: 'changed', label: 'Not default' },
]

const chipClass: Record<SettingLayer | 'here', string> = {
  default: 'border-dashed border-line text-dim',
  org: 'border-line bg-chip text-foreground',
  group: 'border-line-strong bg-chip text-foreground',
  repo: 'border-line bg-chip text-muted',
  here: 'border-[color-mix(in_oklab,var(--accent)_34%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-accent',
}

/** Where a value comes from as a chip in the layer's style; the focus's own layer is accented. */
function SourceChip({
  layer,
  here,
  children,
}: {
  layer: SettingLayer
  here?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex h-5 items-center whitespace-nowrap rounded-[5px] border px-[7px] text-[11.5px] font-medium ${chipClass[here ? 'here' : layer]}`}
    >
      {children}
    </span>
  )
}

const overriddenRowClass =
  '[&>td]:bg-[color-mix(in_oklab,var(--accent)_6%,transparent)] [&>td:first-child]:shadow-[inset_2px_0_var(--accent)]'

/**
 * Every setting as it applies to a repository or a group: the winning value, the layer it comes
 * from (default, org, group, repository) and what it replaces, grouped by category with filters
 * and a layer legend. People with `settings:write` override a key for the focus inline, edit or
 * remove the focus's own entry, or open the full editor. For a repository the Updates category
 * also shows its webhook, polling and recent events. `section` picks a category (`updates`, a
 * definition section slug); `onSection` keeps it in the URL, otherwise it is local state.
 */
export function ResolvedSettings({
  focus,
  groups,
  section,
  onSection,
}: {
  focus: ScopeFocus
  /** Known groups, offered in the scope editor of the full editor. */
  groups: readonly string[]
  section?: string | undefined
  onSection?: (section: string | undefined) => void
}) {
  const titleOf = useGroupTitles()
  const { can, principal } = useSession()
  const elsewhere = visibleSettingsSections(principal).filter(
    (id) => id === 'analyzers' || id === 'policies' || id === 'audit',
  )
  const resolved = useResolvedScope(focus)
  const settings = useSettings()
  const credentials = useCredentials(can('credentials:read'))
  const { put, remove } = useSettingMutations()
  const [localSection, setLocalSection] = useState<string>()
  const [filter, setFilter] = useState<ResolvedFilter>('all')
  const [query, setQuery] = useState('')
  const [inline, setInline] = useState<Editing & { value: unknown }>()
  const [dialog, setDialog] = useState<Editing>()
  const [deleting, setDeleting] = useState<Editing>()
  const writable = can('settings:write')
  const here = focus.kind === 'repo' ? 'this repository' : 'this group'

  if (resolved.isPending || settings.isPending) return <Placeholder className="h-64" />
  if (resolved.isError) return <ErrorState error={resolved.error} />
  if (settings.isError) return <ErrorState error={settings.error} />

  const definitions = new Map(settings.data.definitions.map((d) => [d.key, d]))
  const sections = resolvedSections(resolved.data.rows)
  const categories = [
    ...sections.map(({ id, label, rows }) => ({ id, label, count: rows.length })),
    ...(focus.kind === 'repo' && !sections.some((s) => s.id === UPDATES)
      ? [{ id: UPDATES, label: 'Updates', count: 0 }]
      : []),
  ]
  const wanted = onSection ? section : localSection
  const selected = categories.some((c) => c.id === wanted) ? wanted : undefined
  const choose = (next: string | undefined) => (onSection ?? setLocalSection)(next)
  const shown = sections
    .filter((s) => selected === undefined || s.id === selected)
    .map(({ id, label, rows }) => ({
      id,
      label,
      rows: rows.filter((row) => rowMatches(row, focus, filter, query)),
    }))
    .filter((s) => s.rows.length > 0)
  const counts = layerCounts(resolved.data.rows)
  const inherited =
    focusParent(focus) === undefined ? undefined : parentGroupCount(resolved.data.rows, focus)
  const filterCounts: Record<ResolvedFilter, number> = {
    all: resolved.data.rows.length,
    here: resolved.data.rows.filter((row) => setHere(row, focus)).length,
    changed: resolved.data.rows.filter((row) => row.source.layer !== 'default').length,
  }
  const groupNames = resolved.data.groups.map(titleOf).join(', ')
  const showUpdates = focus.kind === 'repo' && (selected === undefined || selected === UPDATES)

  const display = (definition: SettingDefinitionView | undefined, value: unknown) =>
    (definition && editorFor(definition.schema, definition.secret).kind === 'credential'
      ? findCredential(credentials.data?.credentials ?? [], value)?.name
      : undefined) ?? previewValue(value, false)

  const replacedBy = (
    row: ResolvedSettingRow,
    editing: Editing,
    definition: SettingDefinitionView | undefined,
  ) => {
    const replaced = editing.entry ? row.replaces : { ...row.source, value: row.value }
    return replaced
      ? `${display(definition, replaced.value)} · ${sourceLabel(replaced, focus, titleOf)}`
      : 'the default'
  }

  const save = () => {
    if (!inline || inline.value === undefined) return
    put.mutate(
      {
        ...(inline.entry ? { id: inline.entry.id } : {}),
        key: inline.definition.key,
        scope: inline.entry?.scope ?? scopeOfFocus(focus),
        value: inline.value,
      },
      {
        onSuccess: () => {
          notify.success('Override saved', inline.definition.label)
          setInline(undefined)
        },
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )
  }

  const actions = (row: ResolvedSettingRow, definition: SettingDefinitionView) => {
    if (!writable) return null
    if (definition.global) return <span className="text-xs text-dim">One value for all</span>
    const own = setHere(row, focus) ? row.entry : undefined
    if (own)
      return (
        <span className="inline-flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={`Edit ${definition.label}`}
            onPress={() =>
              isSharedScope(own.scope)
                ? setDialog({ definition, entry: own })
                : setInline({ definition, entry: own, value: own.value })
            }
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={`Remove the override of ${definition.label}`}
            onPress={() => setDeleting({ definition, entry: own })}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      )
    return (
      <Button
        variant="ghost"
        size="sm"
        onPress={() => setInline({ definition, value: row.value ?? undefined })}
      >
        <Plus className="size-3.5" />
        Override
      </Button>
    )
  }

  const settingRow = (row: ResolvedSettingRow) => {
    const definition = definitions.get(row.key)
    const editing = inline?.definition.key === row.key ? inline : undefined
    const own = setHere(row, focus)
    return (
      <Fragment key={row.key}>
        <tr className={`align-top ${own ? overriddenRowClass : ''}`}>
          <Td>
            <div className="font-medium">{row.label}</div>
            <div className="mono text-[11px] text-dim">{row.key}</div>
          </Td>
          <Td>
            <span className="mono block max-w-72 truncate text-xs">
              {display(definition, row.value)}
            </span>
          </Td>
          <Td>
            <SourceChip layer={row.source.layer} here={own}>
              {sourceLabel(row.source, focus, titleOf)}
            </SourceChip>
          </Td>
          <Td>
            {row.replaces ? (
              <span className="mono block max-w-64 truncate text-xs text-muted">
                {display(definition, row.replaces.value)} ·{' '}
                {sourceLabel(row.replaces, focus, titleOf)}
              </span>
            ) : (
              <span className="text-xs text-dim">—</span>
            )}
          </Td>
          <Td align="right">{definition ? actions(row, definition) : null}</Td>
        </tr>
        {editing ? (
          <tr>
            <td colSpan={5} className="border-b border-line bg-raise px-3.5 py-3">
              <InlineEditor
                editing={editing}
                replaces={replacedBy(row, editing, definition)}
                here={here}
                saving={put.isPending}
                onChange={(value) => setInline({ ...editing, value })}
                onCancel={() => setInline(undefined)}
                onSave={save}
                onMore={() => {
                  setInline(undefined)
                  setDialog(editing)
                }}
              />
            </td>
          </tr>
        ) : null}
      </Fragment>
    )
  }

  const table = (list: readonly ResolvedSection[]) => (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <Table label="Effective settings">
        <thead>
          <tr>
            <Th>Setting</Th>
            <Th>Value here</Th>
            <Th>Source</Th>
            <Th>Replaces</Th>
            <Th align="right">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {list.map(({ id, label, rows }) => (
            <Fragment key={id}>
              <tr>
                <th
                  colSpan={5}
                  scope="colgroup"
                  className="border-b border-line bg-raise px-3.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted"
                >
                  {label} <Count>{rows.length}</Count>
                </th>
              </tr>
              {rows.map(settingRow)}
            </Fragment>
          ))}
        </tbody>
      </Table>
    </section>
  )

  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start">
      <nav aria-label="Setting categories" className="flex shrink-0 flex-col gap-0.5 md:w-48">
        <CategoryButton
          label="All settings"
          count={resolved.data.rows.length}
          current={selected === undefined}
          onPress={() => choose(undefined)}
        />
        {categories.map((category) => (
          <CategoryButton
            key={category.id}
            label={category.label}
            count={category.count}
            current={selected === category.id}
            onPress={() => choose(category.id)}
          />
        ))}
        {elsewhere.length ? (
          <div className="mt-3 flex flex-col gap-0.5 border-t border-line pt-3">
            <span className="px-2.5 pb-1 text-[11px] font-medium text-dim">Elsewhere</span>
            {elsewhere.map((id) => (
              <Link
                key={id}
                to="/settings/$section"
                params={{ section: id }}
                className="flex h-7 items-center rounded-[7px] px-2.5 text-[12.5px] text-muted no-underline hover:bg-raise hover:text-foreground"
              >
                {elsewhereLabels[id]}
              </Link>
            ))}
          </div>
        ) : null}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <header className="flex flex-col gap-2">
          <div>
            <h3 className="text-[13px] font-semibold">Effective configuration</h3>
            <p className="text-xs text-muted">
              Every setting as it applies to {here}
              {focus.kind === 'group'
                ? ' for members no narrower entry names'
                : groupNames
                  ? ` (groups ${groupNames})`
                  : ''}
              , and where the value comes from.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              aria-label="Which settings"
              options={filters.map(({ id, label }) => ({
                id,
                label: (
                  <>
                    {label} <span className="tabular text-dim">{filterCounts[id]}</span>
                  </>
                ),
              }))}
              value={filter}
              onChange={setFilter}
            />
            <SearchInput
              aria-label="Filter settings"
              placeholder="Filter settings"
              value={query}
              onChange={setQuery}
              className="w-56"
            />
            {elsewhere.includes('analyzers') ? (
              <LinkButton
                to="/settings/$section"
                params={{ section: 'analyzers' }}
                variant="ghost"
                size="sm"
                className="ms-auto"
              >
                <SlidersHorizontal className="size-3.5" />
                Edit defaults
              </LinkButton>
            ) : null}
          </div>
          <ol
            aria-label="Layers, resolved in order, later wins"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted"
          >
            <li className="text-dim">Resolved in order, later wins:</li>
            <li className="inline-flex items-center gap-1.5">
              <SourceChip layer="default">Default</SourceChip>
              <span className="mono text-dim">{counts.default}</span>
            </li>
            <li aria-hidden>→</li>
            <li className="inline-flex items-center gap-1.5">
              <SourceChip layer="org">Org</SourceChip>
              <span className="mono text-dim">{counts.org}</span>
            </li>
            <li aria-hidden>→</li>
            {inherited !== undefined ? (
              <>
                <li className="inline-flex items-center gap-1.5">
                  <SourceChip layer="group">Parent group</SourceChip>
                  <span className="mono text-dim">{inherited}</span>
                </li>
                <li aria-hidden>→</li>
              </>
            ) : null}
            <li className="inline-flex items-center gap-1.5">
              <SourceChip layer="group" here={focus.kind === 'group'}>
                {focus.kind === 'group'
                  ? 'This group'
                  : groupNames
                    ? `Group ${groupNames}`
                    : 'Groups'}
              </SourceChip>
              <span className="mono text-dim">{counts.group - (inherited ?? 0)}</span>
            </li>
            {focus.kind === 'repo' ? (
              <>
                <li aria-hidden>→</li>
                <li className="inline-flex items-center gap-1.5">
                  <SourceChip layer="repo" here>
                    This repo
                  </SourceChip>
                  <span className="mono text-dim">{counts.repo}</span>
                </li>
              </>
            ) : null}
          </ol>
        </header>

        {shown.length ? (
          table(shown)
        ) : selected === UPDATES ? null : (
          <EmptyState
            icon={<SlidersHorizontal />}
            title="No settings match"
            description={
              filter === 'here' ? `Nothing is set for ${here} alone.` : 'Try another filter.'
            }
          />
        )}

        {showUpdates && focus.kind === 'repo' ? <RepoUpdatesSection repo={focus.repo} /> : null}

        <p className="text-xs text-muted">
          Overrides are written to the{' '}
          {elsewhere.includes('audit') ? (
            <Link
              to="/settings/$section"
              params={{ section: 'audit' }}
              className="text-foreground hover:underline"
            >
              audit log
            </Link>
          ) : (
            'audit log'
          )}
          . Values for everything and for groups are edited in{' '}
          {elsewhere.includes('analyzers') ? (
            <Link
              to="/settings/$section"
              params={{ section: 'analyzers' }}
              className="text-foreground hover:underline"
            >
              Settings
            </Link>
          ) : (
            'Settings'
          )}{' '}
          or with the full editor.
        </p>
      </div>

      {dialog ? (
        <EntryDialog
          key={dialog.entry?.id ?? dialog.definition.key}
          definition={dialog.definition}
          {...(dialog.entry ? { entry: dialog.entry } : { initialScope: scopeOfFocus(focus) })}
          groups={groups}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      <ConfirmDialog
        isOpen={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title={`Remove the override of ${deleting?.definition.label ?? 'this setting'}?`}
        confirmLabel="Remove"
        isPending={remove.isPending}
        onConfirm={() =>
          deleting?.entry &&
          remove.mutate(deleting.entry.id, {
            onSuccess: () => {
              notify.success('Override removed')
              setDeleting(undefined)
            },
            onError: (error) => notify.error('Not removed', messageOf(error)),
          })
        }
      >
        {focus.kind === 'group'
          ? 'Repositories in this group fall back to broader entries or the default.'
          : 'This repository falls back to broader entries or the default.'}
      </ConfirmDialog>
    </div>
  )
}

const elsewhereLabels: Partial<Record<SettingsSectionId, string>> = {
  analyzers: 'Analyzer defaults',
  policies: 'Policies',
  audit: 'Audit log',
}

function CategoryButton({
  label,
  count,
  current,
  onPress,
}: {
  label: string
  count: number
  current: boolean
  onPress: () => void
}) {
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      onClick={onPress}
      className={`flex h-[30px] min-w-0 items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus ${
        current
          ? 'bg-raise text-foreground shadow-[inset_0_0_0_1px_var(--line-strong)]'
          : 'text-muted hover:bg-raise hover:text-foreground'
      }`}
    >
      <span className="truncate">{label}</span>
      <span className="ml-auto text-[11px] text-dim">{count}</span>
    </button>
  )
}

/** The row editor of one override: the value, what it replaces, save or cancel. */
function InlineEditor({
  editing,
  replaces,
  here,
  saving,
  onChange,
  onCancel,
  onSave,
  onMore,
}: {
  editing: Editing & { value: unknown }
  replaces: string
  here: string
  saving: boolean
  onChange: (value: unknown) => void
  onCancel: () => void
  onSave: () => void
  onMore: () => void
}) {
  const { definition } = editing
  return (
    <div className="flex flex-col gap-3">
      <ValueEditor
        editor={editorFor(definition.schema, definition.secret)}
        schema={definition.schema}
        initial={editing.value}
        onChange={onChange}
        label={`${definition.label} for ${here}`}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          Replaces <span className="mono">{replaces}</span>
        </span>
        <span className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onPress={onMore}>
            Full editor
          </Button>
          <Button variant="tertiary" size="sm" onPress={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            isDisabled={editing.value === undefined}
            isPending={saving}
            onPress={onSave}
          >
            Save override
          </Button>
        </span>
      </div>
    </div>
  )
}

/** A link to where `settingKey` is edited: the page that owns it or its Settings section. */
function HomeLink({ settingKey }: { settingKey: string }) {
  const home = settingHome(settingKey)
  const className = 'text-xs text-muted hover:underline'
  if ('page' in home) {
    const page = settingsPageHomes[home.page]
    return (
      <Link to={page.to} className={className}>
        {page.label}
      </Link>
    )
  }
  return (
    <Link
      to="/settings/$section"
      params={{ section: home.section }}
      hash={settingAnchor(settingKey)}
      className={className}
    >
      Settings › {settingsSections[home.section].label}
    </Link>
  )
}

/** Who sets an organization-level value: the default (dashed) or an org entry, and narrower entries. */
function OrgSource({ row }: { row: OrgSettingRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <SourceChip layer={row.source.layer}>
        {row.source.layer === 'default' ? 'Default' : 'Organization'}
      </SourceChip>
      {row.narrower ? (
        <span className="text-[11.5px] text-dim">
          {row.narrower} narrower {row.narrower === 1 ? 'entry' : 'entries'}
        </span>
      ) : null}
    </span>
  )
}

/** Edit and reset controls of one org row, with the dialogs they open. */
function useOrgEditing(groups: readonly string[]) {
  const { canGlobal } = useSession()
  const { remove } = useSettingMutations()
  const [dialog, setDialog] = useState<Editing>()
  const [resetting, setResetting] = useState<Editing>()
  const writable = canGlobal('settings:write')
  const controls = (row: OrgSettingRow, definition: SettingDefinitionView | undefined) =>
    writable && definition ? (
      <span className="inline-flex">
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label={`Change ${row.label}`}
          onPress={() => setDialog({ definition, ...(row.entry && { entry: row.entry }) })}
        >
          <Pencil className="size-3.5" />
        </Button>
        {row.entry ? (
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={`Reset ${row.label} to its default`}
            onPress={() => setResetting({ definition, ...(row.entry && { entry: row.entry }) })}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </span>
    ) : null
  const dialogs = (
    <>
      {dialog ? (
        <EntryDialog
          key={dialog.entry?.id ?? dialog.definition.key}
          definition={dialog.definition}
          {...(dialog.entry ? { entry: dialog.entry } : { initialScope: { all: true } })}
          groups={groups}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      <ConfirmDialog
        isOpen={resetting !== undefined}
        onOpenChange={(open) => !open && setResetting(undefined)}
        title={`Reset ${resetting?.definition.label ?? 'this setting'} to its default?`}
        confirmLabel="Reset"
        isPending={remove.isPending}
        onConfirm={() =>
          resetting?.entry &&
          remove.mutate(resetting.entry.id, {
            onSuccess: () => {
              notify.success('Setting reset', resetting.definition.label)
              setResetting(undefined)
            },
            onError: (error) => notify.error('Not reset', messageOf(error)),
          })
        }
      >
        The organization-wide entry is removed; entries for groups and repositories stay.
      </ConfirmDialog>
    </>
  )
  return { controls, dialogs }
}

/**
 * Settings › System › Background work: the system section's own keys (library index, polling,
 * tool versions, the freshness sweep) at the organization layer, grouped by category, each with
 * its value, who sets it and, with a global `settings:write`, change and reset. Ends with the
 * state of the write-task switch, which lives in Ops › Tasks.
 */
export function BackgroundWork() {
  const settings = useSettings()
  const groups = useGroups()
  const groupNames = (groups.data?.entries ?? []).map((entry) => entry.id)
  const { controls, dialogs } = useOrgEditing(groupNames)
  if (settings.isPending) return <Placeholder className="h-48" />
  if (settings.isError) return <ErrorState error={settings.error} />
  const definitions = new Map(settings.data.definitions.map((d) => [d.key, d]))
  const own = definitionsOf(settings.data.definitions, settingsSections.system.keys)
  const rows = orgRows(own, settings.data.settings)
  const sections = resolvedSections(rows)
  const [tasks] = orgRows(
    definitionsOf(settings.data.definitions, ['tasks.write']),
    settings.data.settings,
  )
  const tasksOn = tasks?.value === true || (isRecord(tasks?.value) && tasks.value.enabled === true)
  return (
    <>
      <Table label="Background work">
        <thead>
          <tr>
            <Th>Setting</Th>
            <Th>Value</Th>
            <Th>Set by</Th>
            <Th>
              <span className="sr-only">Change</span>
            </Th>
          </tr>
        </thead>
        {sections.map((section) => (
          <tbody key={section.id}>
            <tr>
              <th
                colSpan={4}
                scope="colgroup"
                className="border-b border-line bg-raise px-3 py-1.5 text-left text-[11.5px] font-semibold"
              >
                {section.label}
              </th>
            </tr>
            {section.rows.map((row) => {
              const definition = definitions.get(row.key)
              return (
                <Tr key={row.key} id={settingAnchor(row.key)} className="scroll-mt-4">
                  <Td>
                    <div className="font-medium">{row.label}</div>
                    <div className="text-[11.5px] text-dim">
                      {definition?.description ?? row.key}
                    </div>
                  </Td>
                  <Td className="mono">{previewValue(row.value, false)}</Td>
                  <Td>
                    <OrgSource row={row} />
                  </Td>
                  <Td align="right">{controls(row, definition)}</Td>
                </Tr>
              )
            })}
          </tbody>
        ))}
      </Table>
      {tasks ? (
        <p className="m-0 flex flex-wrap items-center gap-1.5 border-t border-line px-3.5 py-2.5 text-xs">
          <span aria-hidden className={`size-1.5 rounded-full ${tasksOn ? 'bg-ok' : 'bg-dim'}`} />
          <span>Agents may change code: {tasksOn ? 'On' : 'Off'}</span>
          <span className="text-muted">· the switch and its caps live in</span>
          <Link to="/ops/tasks" className="font-medium hover:underline">
            Ops › Tasks
          </Link>
        </p>
      ) : null}
      {dialogs}
    </>
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const focusOf = (value: string): ScopeFocus => {
  const repo = value.startsWith('repo:') ? parseRepoKey(value.slice(5)) : undefined
  return repo ? { kind: 'repo', repo } : { kind: 'group', group: value }
}

/**
 * Settings › System › All keys: how many settings exist, the ones without a page of their own as
 * tags, and behind "Show all keys" every key with its winner and source (decision 7). The
 * organization view resolves keys from the entries; picking a group or a repository shows the
 * settings resolver for it. Opens by itself when the URL points at a key homed here.
 */
export function AllKeys() {
  const titleOf = useGroupTitles()
  const settings = useSettings()
  const groups = useGroups()
  const repos = useRepos()
  const groupNames = (groups.data?.entries ?? []).map((entry) => entry.id)
  const repoKeys = (repos.data?.repos ?? []).map((summary) => repoKey(summary.repo)).toSorted()
  const { controls, dialogs } = useOrgEditing(groupNames)
  const [open, setOpen] = useState(() => window.location.hash.startsWith('#setting-'))
  const [query, setQuery] = useState('')
  const [changedOnly, setChangedOnly] = useState(false)
  const [focus, setFocus] = useState('')
  if (settings.isPending) return <Placeholder className="h-24" />
  if (settings.isError) return <ErrorState error={settings.error} />
  const definitions = new Map(settings.data.definitions.map((d) => [d.key, d]))
  const homed = new Set<string>(settingsSections.system.keys)
  const homeless = sectionDefinitions(settings.data.definitions, 'system').filter(
    (definition) => !homed.has(definition.key),
  )
  const rows = orgRows(settings.data.definitions, settings.data.settings)
  const shown = rows.filter((row) => orgRowMatches(row, query, changedOnly))
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-3">
        <span className="text-xs text-muted">
          {rows.length} settings.
          {homeless.length
            ? ` ${homeless.length === 1 ? 'This one has' : `These ${homeless.length} have`} no page of their own:`
            : ' Every one has a page of its own.'}
        </span>
        <span className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={open}
          onPress={() => setOpen((current) => !current)}
        >
          {open ? 'Hide all keys' : 'Show all keys'}
        </Button>
      </div>
      {homeless.length ? (
        <div className="flex flex-wrap gap-1 px-3.5 pb-3.5">
          {homeless.map((definition) => (
            <a
              key={definition.key}
              href={`#${settingAnchor(definition.key)}`}
              onClick={() => setOpen(true)}
            >
              <Tag mono>{definition.key}</Tag>
            </a>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="flex flex-col border-t border-line">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <Select
              aria-label="Resolve for"
              className="w-56"
              value={focus || 'org'}
              onChange={(value) => setFocus(value === 'org' ? '' : value)}
              options={[
                { id: 'org', label: 'Organization' },
                ...groupNames.map((group) => ({ id: group, label: `Group ${titleOf(group)}` })),
                ...repoKeys.map((key) => ({ id: `repo:${key}`, label: key })),
              ]}
            />
            {focus ? null : (
              <>
                <SearchInput
                  aria-label="Filter keys"
                  placeholder="Filter by key or label"
                  value={query}
                  onChange={setQuery}
                  className="w-60"
                />
                <Segmented
                  aria-label="Which keys"
                  value={changedOnly ? 'changed' : 'all'}
                  onChange={(value) => setChangedOnly(value === 'changed')}
                  options={[
                    { id: 'all', label: 'All' },
                    { id: 'changed', label: 'Not default' },
                  ]}
                />
                <span className="ms-auto text-xs text-muted">
                  {shown.length} of {rows.length}
                </span>
              </>
            )}
          </div>
          {focus ? (
            <div className="border-t border-line p-3.5">
              <ResolvedSettings key={focus} focus={focusOf(focus)} groups={groupNames} />
            </div>
          ) : shown.length ? (
            <div className="border-t border-line">
              <Table label="All keys">
                <thead>
                  <tr>
                    <Th>Key</Th>
                    <Th>Value</Th>
                    <Th>Set by</Th>
                    <Th>Edited in</Th>
                    <Th>
                      <span className="sr-only">Change</span>
                    </Th>
                  </tr>
                </thead>
                <tbody className="[&>tr:last-child>td]:border-b-0">
                  {shown.map((row) => {
                    const home = settingHome(row.key)
                    const here =
                      !homed.has(row.key) && 'section' in home && home.section === 'system'
                    return (
                      <Tr
                        key={row.key}
                        {...(here && { id: settingAnchor(row.key) })}
                        className="scroll-mt-4"
                      >
                        <Td>
                          <div className="mono font-medium">{row.key}</div>
                          <div className="text-[11.5px] text-dim">{row.label}</div>
                        </Td>
                        <Td className="mono max-w-[320px] truncate">
                          {previewValue(row.value, false)}
                        </Td>
                        <Td>
                          <OrgSource row={row} />
                        </Td>
                        <Td>
                          <HomeLink settingKey={row.key} />
                        </Td>
                        <Td align="right">{controls(row, definitions.get(row.key))}</Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </Table>
            </div>
          ) : (
            <EmptyState
              icon={<SlidersHorizontal />}
              title="No key matches"
              description="Try part of the key or show every key."
            />
          )}
        </div>
      ) : null}
      {dialogs}
    </div>
  )
}
