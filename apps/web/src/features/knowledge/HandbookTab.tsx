import { type Family } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { BookMarked, ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useHandbook, useKnowledge, useTeamTitles } from '../../api/queries.ts'
import { type Space, spaceKey } from '../../lib/guide.ts'
import {
  chapterAnchor,
  entriesOf,
  entryAnchor,
  filterHandbook,
  handbookQuery,
} from '../../lib/handbook.ts'
import {
  Count,
  EmptyState,
  ErrorState,
  Placeholder,
  SearchInput,
  SegmentedTabs,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { HandbookEntrySection } from './HandbookEntrySection.tsx'
import { HandbookGraph } from './HandbookGraph.tsx'
import { NoteSheet } from './NoteSheet.tsx'

const scrollTo = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

/**
 * All accepted knowledge of a space as one article: a table of contents, chapters with their
 * entries (text, scope, freshness, evidence, related entries) and a collapsible relationship
 * graph. Filters narrow the text on the client; an entry or a proposed replacement opens in the
 * Notes side sheet (`?note=<id>`).
 */
export function HandbookTab({ space, families }: { space: Space; families: readonly Family[] }) {
  const { can } = useSession()
  const titleOf = useTeamTitles()
  const navigate = useNavigate()
  const note = useSearch({ strict: false, select: (search) => search.note })
  const handbook = useHandbook(handbookQuery(space))
  const notes = useKnowledge({}, note !== undefined)
  const [text, setText] = useState('')
  const [attention, setAttention] = useState(false)
  const [graphOpen, setGraphOpen] = useState(true)
  const [selected, setSelected] = useState<string>()
  const familyId = space.kind === 'family' ? space.family : undefined
  const members = useMemo(
    () => (familyId ? (families.find((f) => f.id === familyId)?.members ?? []) : undefined),
    [families, familyId],
  )

  const view = useMemo(
    () =>
      handbook.data
        ? filterHandbook(handbook.data, { text, attention, ...(members ? { members } : {}) })
        : undefined,
    [handbook.data, text, attention, members],
  )
  const visibleIds = useMemo(() => new Set(view ? entriesOf(view).map((e) => e.id) : []), [view])
  const titles = useMemo(
    () => new Map(view ? entriesOf(view).map((e) => [e.id, e.title]) : []),
    [view],
  )

  if (handbook.isPending) return <Placeholder className="h-72" />
  if (handbook.isError) return <ErrorState error={handbook.error} />
  if (!view) return null

  const total = handbook.data.counts.entries
  const warnings = handbook.data.counts.suspect + handbook.data.counts.stale
  const openNote = (id: string | undefined) =>
    void navigate({
      to: '/knowledge/handbook',
      search: { space: spaceKey(space), ...(id ? { note: id } : {}) },
      replace: true,
    })
  const select = (id: string) => {
    setSelected(id)
    scrollTo(entryAnchor(id))
  }
  const current = notes.data?.entries.find((entry) => entry.id === note)

  if (total === 0)
    return (
      <div className="rounded-xl border border-line bg-panel">
        <EmptyState
          icon={<BookMarked />}
          title="The handbook is empty"
          description="Accepted notes of this space appear here as one article. Add notes in the Notes tab, or accept proposals from the Inbox."
        />
      </div>
    )

  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          aria-label="Filter handbook"
          placeholder="Filter by title, text or topic"
          value={text}
          onChange={setText}
          className="w-64"
        />
        <SegmentedTabs
          aria-label="Freshness"
          selected={attention ? 'attention' : 'all'}
          onSelect={(id) => setAttention(id === 'attention')}
          items={[
            {
              id: 'all',
              label: (
                <>
                  All <Count>{total}</Count>
                </>
              ),
            },
            {
              id: 'attention',
              label: (
                <>
                  Needs attention <Count tone={warnings ? 'warning' : undefined}>{warnings}</Count>
                </>
              ),
            },
          ]}
        />
      </div>
      <div className="rounded-xl border border-line bg-panel">
        <button
          type="button"
          aria-expanded={graphOpen}
          className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left font-medium"
          onClick={() => setGraphOpen((open) => !open)}
        >
          {graphOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Relationships
          <span className="text-xs font-normal text-muted">
            {titles.size} entries · {view.links.length} links
          </span>
        </button>
        {graphOpen ? (
          <div className="border-t border-line p-3">
            {titles.size === 0 ? (
              <p className="text-muted">Nothing to draw.</p>
            ) : (
              <HandbookGraph
                chapters={handbook.data.chapters}
                links={handbook.data.links}
                visible={visibleIds}
                selected={selected}
                onSelect={select}
              />
            )}
          </div>
        ) : null}
      </div>
      {view.chapters.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState
            title="Nothing matches"
            description="Change or clear the filters to see more of the handbook."
          />
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[14rem_minmax(0,1fr)]">
          <nav aria-label="Chapters" className="xl:sticky xl:top-4 xl:self-start">
            <ol className="flex flex-col gap-0.5">
              {view.chapters.map((chapter) => (
                <li key={chapter.key}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-default"
                    onClick={() => scrollTo(chapterAnchor(chapter.key))}
                  >
                    <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
                    <Count>{chapter.entries.length}</Count>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <article className="flex min-w-0 flex-col gap-8">
            {view.chapters.map((chapter) => (
              <section key={chapter.key} id={chapterAnchor(chapter.key)} className="scroll-mt-4">
                <h2 className="mb-3 border-b border-line pb-1 text-xl font-semibold">
                  {chapter.title}
                </h2>
                <div className="flex flex-col gap-3">
                  {chapter.entries.map((entry) => (
                    <HandbookEntrySection
                      key={entry.id}
                      entry={entry}
                      links={view.links}
                      titles={titles}
                      titleOf={titleOf}
                      selected={entry.id === selected}
                      onSelect={select}
                      onOpenNote={openNote}
                    />
                  ))}
                </div>
              </section>
            ))}
          </article>
        </div>
      )}
      <NoteSheet
        entry={current}
        space={space}
        people={notes.data?.people ?? {}}
        writable={can('knowledge:write')}
        onOpen={openNote}
        onClose={() => openNote(undefined)}
      />
    </div>
  )
}
