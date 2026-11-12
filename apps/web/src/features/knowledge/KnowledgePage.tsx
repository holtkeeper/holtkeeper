import type { GuideSectionName } from '@holtkeeper/api'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { Plus, SquareTerminal } from 'lucide-react'
import { useState } from 'react'

import { useFamilies, useKnowledgeCounts, useRepos } from '../../api/queries.ts'
import {
  type KnowledgeTab,
  type Space,
  knowledgeSearch,
  knowledgeTabOf,
  parseSpace,
  reposOfSpace,
  spaceCounts,
  spaceKey,
  spaceTrail,
} from '../../lib/guide.ts'
import { repoKey } from '../../lib/repo.ts'
import { knowledgeSettingsLink } from '../../lib/settings-sections.ts'
import { Button, Count, Page } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { EffectivePromptPanel } from './EffectivePrompt.tsx'
import { GuideTab } from './GuideTab.tsx'
import { LearningsTable } from './LearningsTable.tsx'
import { NotesTable } from './NotesTable.tsx'
import { SpacesSidebar } from './SpacesSidebar.tsx'

const tabPaths = {
  guide: '/knowledge/guide',
  notes: '/knowledge/notes',
  learnings: '/knowledge/learnings',
} as const satisfies Record<KnowledgeTab, string>

/**
 * The single place for rules agents follow: spaces (All, teams, families, repositories) on the
 * left, and for the chosen space its Guide, Notes or Learnings (`/knowledge/<tab>?space=`). The
 * crumbs are the space trail; the Guide's effective prompt opens inline and Notes' New note is the
 * header's primary action.
 */
export function KnowledgePage() {
  const { can } = useSession()
  const search = knowledgeSearch(useSearch({ strict: false }))
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigate = useNavigate()
  const repos = useRepos(can('repos:read'))
  const families = useFamilies()
  const counts = useKnowledgeCounts()
  const [prompt, setPrompt] = useState(false)
  const [creating, setCreating] = useState(false)

  const familyList = families.data?.families ?? []
  const repoList = repos.data?.repos ?? []
  const parsed = parseSpace(search.space)
  const space: Space =
    parsed?.kind === 'family' &&
    families.isSuccess &&
    !familyList.some((f) => f.id === parsed.family)
      ? { kind: 'all' }
      : (parsed ?? { kind: 'all' })
  const tab = knowledgeTabOf(pathname)
  const groups = [...new Set(repoList.flatMap((r) => r.groups))].toSorted()
  const repoKeys = repoList.map((r) => repoKey(r.repo))
  const covered = reposOfSpace(space, repoList, familyList)
  const coveredRepos = repoKeys.filter((key) => !covered || covered.has(key))
  const totals = spaceCounts(counts.data, space)

  const pick = (next: Space) =>
    void navigate({ to: tabPaths[tab], search: { space: spaceKey(next) }, replace: true })
  const pickSection = (section: GuideSectionName | undefined) =>
    void navigate({
      to: '/knowledge/guide',
      search: { space: spaceKey(space), ...(section ? { section } : {}) },
      replace: true,
    })

  return (
    <Page
      crumbs={spaceTrail(space, repoList, familyList).map((step) => ({
        label: step.label,
        link: { to: tabPaths[tab], search: { space: spaceKey(step.space) } },
      }))}
      title="Knowledge"
      tabs={[
        { to: '/knowledge/guide', label: 'Guide' },
        {
          to: '/knowledge/notes',
          label: <>Notes {totals.notes ? <Count>{totals.notes}</Count> : null}</>,
        },
        {
          to: '/knowledge/learnings',
          label: (
            <>
              Learnings{' '}
              {totals.learnings ? (
                <Count tone="warning" label={`${totals.learnings} waiting`}>
                  {totals.learnings}
                </Count>
              ) : null}
            </>
          ),
        },
      ]}
      tabsLabel="Knowledge sections"
      configure={can('settings:read') ? { link: knowledgeSettingsLink(tab) } : undefined}
      {...(tab === 'guide' && {
        actions: (
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={prompt}
            onPress={() => setPrompt((open) => !open)}
          >
            <SquareTerminal className="size-3.5" />
            Effective prompt
          </Button>
        ),
      })}
      {...(tab === 'notes' &&
        can('knowledge:write') && {
          primary: {
            label: 'New note',
            icon: Plus,
            onPress: () => {
              void navigate({ to: '/knowledge/notes', search: { space: spaceKey(space) } })
              setCreating(true)
            },
          },
        })}
    >
      <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
          <SpacesSidebar
            selected={space}
            onSelect={pick}
            repos={repoList}
            families={familyList}
            counts={counts.data}
            canEditFamilies={can('settings:write')}
          />
        </aside>
        <div className="flex min-w-0 flex-col gap-4">
          {prompt && tab === 'guide' ? (
            <EffectivePromptPanel
              key={spaceKey(space)}
              repos={coveredRepos}
              {...(space.kind === 'repo' ? { initial: space.repo } : {})}
              onClose={() => setPrompt(false)}
            />
          ) : null}
          {tab === 'guide' ? (
            <GuideTab
              space={space}
              families={familyList}
              repos={repoList}
              section={search.section}
              onSection={pickSection}
            />
          ) : null}
          {tab === 'notes' ? (
            <NotesTable
              space={space}
              families={familyList}
              groups={groups}
              creating={creating}
              onCreating={setCreating}
            />
          ) : null}
          {tab === 'learnings' ? (
            <LearningsTable space={space} families={familyList} repos={coveredRepos} />
          ) : null}
        </div>
      </div>
    </Page>
  )
}
