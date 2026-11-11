import { useNavigate, useSearch } from '@tanstack/react-router'
import { BookOpen, GraduationCap, ScrollText, Settings2, SquareTerminal } from 'lucide-react'
import { useState } from 'react'

import { useFamilies, useRepos } from '../../api/queries.ts'
import {
  type KnowledgeTab,
  type Space,
  knowledgeTabs,
  parseSpace,
  reposOfSpace,
  scopeLabel,
  spaceKey,
} from '../../lib/guide.ts'
import { repoKey } from '../../lib/repo.ts'
import { Button, Page, SegmentedTabs } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { GuideTab } from './GuideTab.tsx'
import { LearningsTab } from './LearningsTab.tsx'
import { NotesTab } from './NotesTab.tsx'
import { KnowledgeSettingsSheet } from './PolicyBlock.tsx'
import { PreviewSheet } from './PreviewSheet.tsx'
import { SpacesSidebar } from './SpacesSidebar.tsx'

const tabItems = [
  { id: 'guide', label: 'Guide', icon: ScrollText },
  { id: 'notes', label: 'Notes', icon: BookOpen },
  { id: 'learnings', label: 'Learnings', icon: GraduationCap },
] as const

/**
 * The single place for rules agents follow: spaces (All, teams, families, repositories) on the
 * left, and for the chosen space its Guide, Notes and Learnings.
 */
export function KnowledgePage() {
  const { can } = useSession()
  const search = useSearch({ from: '/app/knowledge' })
  const navigate = useNavigate({ from: '/knowledge' })
  const repos = useRepos(can('repos:read'))
  const families = useFamilies()
  const [sheet, setSheet] = useState<'preview' | 'settings' | null>(null)

  const familyList = families.data?.families ?? []
  const repoList = repos.data?.repos ?? []
  const parsed = parseSpace(search.space)
  const space: Space =
    parsed?.kind === 'family' &&
    families.isSuccess &&
    !familyList.some((f) => f.id === parsed.family)
      ? { kind: 'all' }
      : (parsed ?? { kind: 'all' })
  const tab: KnowledgeTab = search.tab ?? 'guide'
  const groups = [...new Set(repoList.flatMap((r) => r.groups))].toSorted()
  const covered = reposOfSpace(space, repoList, familyList)
  const previewRepos = repoList
    .map((r) => repoKey(r.repo))
    .filter((key) => !covered || covered.has(key))

  const go = (next: { space?: Space; tab?: KnowledgeTab }) =>
    void navigate({
      search: (previous) => ({
        ...previous,
        ...(next.space ? { space: spaceKey(next.space) } : {}),
        ...(next.tab ? { tab: next.tab } : {}),
      }),
      replace: true,
    })

  return (
    <Page
      title="Knowledge"
      icon="knowledge"
      description="Team rules, notes and learned rules agents follow; people's rules always win over generated text"
      actions={
        <>
          <Button variant="secondary" onPress={() => setSheet('preview')}>
            <SquareTerminal className="size-4" />
            Effective prompt
          </Button>
          {can('settings:read') ? (
            <Button variant="ghost" onPress={() => setSheet('settings')}>
              <Settings2 className="size-4" />
              Settings
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
          <SpacesSidebar
            selected={space}
            onSelect={(next) => go({ space: next })}
            repos={repoList}
            families={familyList}
            canEditFamilies={can('settings:write')}
          />
        </aside>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="mono min-w-0 truncate text-[13px] font-semibold">
              {scopeLabel(spaceKey(space), familyList)}
            </h2>
            <SegmentedTabs
              aria-label="Space sections"
              items={tabItems}
              selected={tab}
              onSelect={(id) => {
                const next = knowledgeTabs.find((t) => t === id)
                if (next) go({ tab: next })
              }}
            />
          </div>
          {tab === 'guide' ? <GuideTab space={space} families={familyList} /> : null}
          {tab === 'notes' ? (
            <NotesTab space={space} families={familyList} groups={groups} />
          ) : null}
          {tab === 'learnings' ? (
            <LearningsTab space={space} repos={repoList} families={familyList} />
          ) : null}
        </div>
      </div>
      {sheet === 'preview' ? (
        <PreviewSheet
          key={spaceKey(space)}
          repos={previewRepos}
          {...(space.kind === 'repo' ? { initial: space.repo } : {})}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'settings' ? <KnowledgeSettingsSheet onClose={() => setSheet(null)} /> : null}
    </Page>
  )
}
