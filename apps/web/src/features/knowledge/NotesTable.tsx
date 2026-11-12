import type { Family, KnowledgeEntry, KnowledgeEntryView, PersonView } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { BookOpen, Link2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useKnowledge } from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { type Space, scopeLabel, settingScopeOfSpace, spaceKey } from '../../lib/guide.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import {
  type NoteFilter,
  type NoteGrouping,
  filterNotes,
  isInherited,
  kbId,
  kindLabel,
  knowledgeKinds,
  matchesFilter,
  noteFilters,
  noteLink,
  noteSections,
  noteStatusLabel,
  noteTopics,
  noteTotals,
  notesOfSpace,
  statusTone,
  taskKinds,
} from '../../lib/knowledge.ts'
import { personOf } from '../../lib/people.ts'
import {
  Avatar,
  Button,
  Count,
  Dot,
  EmptyState,
  ErrorState,
  FilterButton,
  Kbd,
  ListFooter,
  OtherTeams,
  Placeholder,
  SearchInput,
  SegmentedTabs,
  Strip,
  Table,
  Tag,
  Td,
  Th,
  Tooltip,
  Tr,
  notify,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { NoteSheet } from './NoteSheet.tsx'

const COLUMNS = 5

const copyLink = async (id: string) => {
  try {
    await navigator.clipboard.writeText(noteLink(window.location.origin, id))
    notify.success('Link copied')
  } catch {
    notify.error('Not copied', 'The browser did not allow the clipboard.')
  }
}

/**
 * Notes of a space as one table grouped by topic or kind, proposals first under "Waiting for
 * review", other teams' notes folded into a row under the table. A row opens the note in a side
 * sheet (`?note=<id>`) with its text, history and evidence; New note opens the sheet's form.
 * `groups` are offered in the scope editor.
 */
export function NotesTable({
  space,
  families,
  groups,
  creating,
  onCreating: setCreating,
}: {
  space: Space
  families: readonly Family[]
  groups: readonly string[]
  /** The New note form is open; the page header's primary action opens it. */
  creating: boolean
  onCreating: (open: boolean) => void
}) {
  const { can } = useSession()
  const { homeGroups } = useScope()
  const note = useSearch({ strict: false, select: (search) => search.note })
  const navigate = useNavigate()
  const knowledge = useKnowledge(space.kind === 'repo' ? { repo: space.repo } : {})
  const [filter, setFilter] = useState<NoteFilter>('live')
  const [grouping, setGrouping] = useState<NoteGrouping>('status')
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<string[]>([])
  const [topics, setTopics] = useState<string[]>([])
  const [tasks, setTasks] = useState<string[]>([])
  const writable = can('knowledge:write')
  const members =
    space.kind === 'family' ? (families.find((f) => f.id === space.family)?.members ?? []) : []

  const open = (id: string | undefined) => {
    setCreating(false)
    void navigate({
      to: '/knowledge/notes',
      search: { space: spaceKey(space), ...(id ? { note: id } : {}) },
      replace: true,
    })
  }

  if (knowledge.isPending) return <Placeholder className="h-72" />
  if (knowledge.isError) return <ErrorState error={knowledge.error} />

  const { people } = knowledge.data
  const inSpace = notesOfSpace(knowledge.data.entries, space, members)
  const shown = filterNotes(inSpace, { filter, text: query, kinds, topics, tasks })
  const folded = foldOtherTeams(
    shown,
    space.kind === 'all' ? homeGroups : [],
    (entry) => entry.owner,
  )
  const sections = noteSections(folded.mine, grouping)
  const ordered = [...sections.flatMap((section) => section.entries), ...folded.others]
  const step = neighbours(
    ordered.map((entry) => entry.id),
    note,
  )
  const current = knowledge.data.entries.find((entry) => entry.id === note)
  const totals = noteTotals(inSpace, space)
  const counts = Object.fromEntries(
    noteFilters.map((f) => [f.id, inSpace.filter((e) => matchesFilter(e, f.id)).length]),
  )
  const filtered = Boolean(query.trim() || kinds.length || topics.length || tasks.length)

  const row = (entry: KnowledgeEntryView) => (
    <NoteRow
      key={entry.id}
      entry={entry}
      space={space}
      people={people}
      open={entry.id === note}
      onOpen={() => open(entry.id)}
    />
  )

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel text-[13px]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <SegmentedTabs
          aria-label="Status"
          selected={filter}
          onSelect={(id) => setFilter(noteFilters.find((f) => f.id === id)?.id ?? 'live')}
          items={noteFilters.map((f) => ({
            id: f.id,
            label: (
              <>
                {f.label} <Count>{counts[f.id] ?? 0}</Count>
              </>
            ),
          }))}
        />
        <span className="flex-1" />
        <SearchInput
          aria-label="Filter notes"
          placeholder="Filter by text, topic or kb id"
          value={query}
          onChange={setQuery}
          className="w-56"
        />
        <FilterButton
          label="Kind"
          all="All"
          options={knowledgeKinds.map((k) => ({ id: k.id, label: k.label }))}
          value={kinds}
          onChange={setKinds}
        />
        <FilterButton
          label="Topic"
          all="All"
          options={noteTopics(inSpace).map((topic) => ({ id: topic, label: topic }))}
          value={topics}
          onChange={setTopics}
        />
        <FilterButton
          label="Task"
          all="Any"
          options={taskKinds.filter((task) => task.id !== '*')}
          value={tasks}
          onChange={setTasks}
        />
        <FilterButton
          label="Group"
          single
          all="Status"
          options={[
            { id: 'status', label: 'Status' },
            { id: 'topic', label: 'Topic' },
            { id: 'kind', label: 'Kind' },
          ]}
          value={[grouping]}
          onChange={(ids) =>
            setGrouping(ids[0] === 'kind' ? 'kind' : ids[0] === 'topic' ? 'topic' : 'status')
          }
        />
      </div>
      <Strip
        label="Notes summary"
        cells={[
          { prefix: 'Space', value: scopeLabel(spaceKey(space), families), label: '' },
          { value: totals.accepted, label: 'accepted' },
          ...(totals.proposed
            ? [
                {
                  value: totals.proposed,
                  label: 'proposed',
                  tone: 'warning' as const,
                  caption: (
                    <Link
                      to="/inbox"
                      search={{ kind: 'note' }}
                      className="hover:text-foreground hover:underline"
                    >
                      also in Inbox
                    </Link>
                  ),
                },
              ]
            : []),
          ...(totals.inherited
            ? [{ value: totals.inherited, label: 'inherited from broader scopes' }]
            : []),
          ...(totals.shared ? [{ value: totals.shared, label: 'shared with other teams' }] : []),
        ]}
      />
      {shown.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title={
            filtered ? 'Nothing matches' : filter === 'live' ? 'No notes yet' : `No ${filter} notes`
          }
          description={
            filtered
              ? 'Change or clear the filters to see more notes.'
              : filter === 'live'
                ? 'Notes are atomic facts picked per task: decisions, quirks, migrations. Agents propose them too; proposals wait here.'
                : undefined
          }
        />
      ) : (
        <Table label="Notes">
          <thead>
            <tr>
              <Th>Permalink</Th>
              <Th className="w-full">Note</Th>
              <Th>Status</Th>
              <Th>Author</Th>
              <Th>
                <span className="sr-only">Copy link</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => (
              <GroupRows
                key={section.id || '-'}
                label={section.label}
                count={section.entries.length}
              >
                {section.entries.map(row)}
              </GroupRows>
            ))}
            <OtherTeams
              variant="row"
              colSpan={COLUMNS}
              count={folded.others.length}
              teams={folded.teams}
              noun={{ one: 'note' }}
            >
              {folded.others.map(row)}
            </OtherTeams>
          </tbody>
        </Table>
      )}
      <ListFooter
        shown={ordered.length}
        total={inSpace.filter((e) => matchesFilter(e, filter)).length}
        noun="notes"
        className="border-t border-line"
        hints={
          <>
            Navigate <Kbd>J</Kbd>
            <Kbd>K</Kbd>
          </>
        }
      />
      <NoteSheet
        entry={current}
        {...(creating ? { creating: settingScopeOfSpace(space, members) } : {})}
        space={space}
        groups={groups}
        people={people}
        writable={writable}
        {...(current && step.index >= 0 ? { index: step.index, total: ordered.length } : {})}
        {...(step.previous ? { onPrevious: () => open(step.previous) } : {})}
        {...(step.next ? { onNext: () => open(step.next) } : {})}
        onOpen={open}
        onClose={() => {
          setCreating(false)
          if (note) open(undefined)
        }}
      />
    </div>
  )
}

function GroupRows({
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: ReactNode
}) {
  return (
    <>
      <tr>
        <td
          colSpan={COLUMNS}
          className="border-b border-line bg-sunk px-3.5 py-1.5 text-[11.5px] font-medium text-muted"
        >
          {label} · <span className="tabular">{count}</span>
        </td>
      </tr>
      {children}
    </>
  )
}

function NoteRow({
  entry,
  space,
  people,
  open,
  onOpen,
}: {
  entry: KnowledgeEntry
  space: Space
  people: Readonly<Record<string, PersonView>>
  open: boolean
  onOpen: () => void
}) {
  const author = personOf(people, entry.author)
  return (
    <Tr selected={open} onClick={onOpen}>
      <Td valign="top">
        <span className="mono text-[12px]">{kbId(entry.id, true)}</span>
      </Td>
      <Td valign="top" className="min-w-56 whitespace-normal">
        <span className="font-medium">{entry.title}</span>
        <div className="mt-1 flex flex-wrap gap-1">
          <Tag>{kindLabel(entry.kind)}</Tag>
          {entry.topics.map((topic) => (
            <Tag key={topic} mono>
              {topic}
            </Tag>
          ))}
          {isInherited(entry, space) ? <Tag tone="info">Inherited</Tag> : null}
          {entry.visibility === 'shared' && entry.status === 'accepted' ? (
            <Tooltip content="Other teams read it through the cross-team catalog">
              <Tag tone="accent">Shared</Tag>
            </Tooltip>
          ) : null}
        </div>
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5">
          <Dot tone={statusTone(entry.status)} />
          {noteStatusLabel[entry.status]}
        </span>
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5">
          <Avatar src={author.avatarUrl} name={author.name} size="xs" />
          <span className="flex flex-col leading-tight">
            <span className={author.known ? '' : 'mono text-[12px]'}>{author.name}</span>
            <span className="text-xs text-dim" title={formatDateTime(entry.updatedAt)}>
              {formatRelative(entry.updatedAt)}
            </span>
          </span>
        </span>
      </Td>
      <Td valign="top" align="right" onClick={(event) => event.stopPropagation()}>
        <Tooltip content="Copy link">
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={`Copy link to ${kbId(entry.id, true)}`}
            onPress={() => void copyLink(entry.id)}
          >
            <Link2 className="size-3.5" />
          </Button>
        </Tooltip>
      </Td>
    </Tr>
  )
}
