import type { Scope } from '@holtkeeper/api'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { Plus, SquareTerminal } from 'lucide-react'
import { useState } from 'react'

import { useLearnings, useRepos, useRules } from '../../api/queries.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { knowledgeSearch } from '../../lib/rules.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import { Button, Count, Page } from '../../ui/index.ts'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useSession } from '../shell/session.ts'
import { EffectivePromptPanel } from './EffectivePrompt.tsx'
import { LearningsTab } from './LearningsTab.tsx'
import { RulesTab } from './RulesTab.tsx'

const everything: Scope = { all: true }

/**
 * Knowledge: the rules people write (`/knowledge/rules`) and the rules Holtkeeper learned
 * (`/knowledge/learnings`) as two tabs. Rules carries the effective prompt of a repository
 * (`?prompt=<forge:path>`) and New rule; Learnings carries New learning. A row opens its sheet
 * (`?rule=<id>`, `?learning=<id>`).
 */
export function KnowledgePage() {
  const { can } = useSession()
  const search = knowledgeSearch(useSearch({ strict: false }))
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigate = useNavigate()
  const tab = pathname.replace(/\/+$/, '').endsWith('/learnings') ? 'learnings' : 'rules'
  const rules = useRules()
  const pending = useLearnings({ status: ['pending'] })
  const repos = useRepos(can('repos:read'))
  const [creating, setCreating] = useState(false)
  const { configure, sheet } = useConfigure('Knowledge settings', pageSettingKeys.knowledge)
  const writable = can('knowledge:write')
  const repoKeys = (repos.data?.repos ?? []).map((repo) => repoKey(repo.repo))
  const ruleCount = rules.data?.rules.length ?? 0
  const pendingCount = pending.data?.learnings.length ?? 0
  const promptRepo = parseRepoKey(search.prompt || undefined)

  const open = (key: 'rule' | 'learning') => (id: string | undefined) => {
    const { [key]: _, ...rest } = search
    void navigate({
      to: key === 'rule' ? '/knowledge/rules' : '/knowledge/learnings',
      search: id ? { ...rest, [key]: id } : rest,
      replace: true,
    })
  }
  const togglePrompt = () => {
    const { prompt, ...rest } = search
    void navigate({
      to: '/knowledge/rules',
      search: prompt === undefined ? { ...rest, prompt: '' } : rest,
      replace: true,
    })
  }

  return (
    <Page
      title="Knowledge"
      tabs={[
        {
          to: '/knowledge/rules',
          label: <>Rules {ruleCount ? <Count>{ruleCount}</Count> : null}</>,
        },
        {
          to: '/knowledge/learnings',
          label: (
            <>
              Learnings{' '}
              {pendingCount ? (
                <Count tone="warning" label={`${pendingCount} pending`}>
                  {pendingCount}
                </Count>
              ) : null}
            </>
          ),
        },
      ]}
      tabsLabel="Knowledge sections"
      {...(configure ? { configure } : {})}
      {...(tab === 'rules' && {
        actions: (
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={search.prompt !== undefined}
            onPress={togglePrompt}
          >
            <SquareTerminal className="size-3.5" />
            Effective prompt
          </Button>
        ),
      })}
      {...(writable &&
        (tab === 'rules' ? (rules.data?.canCreate ?? true) : true) && {
          primary: {
            label: tab === 'rules' ? 'New rule' : 'New learning',
            icon: Plus,
            onPress: () => setCreating(true),
          },
        })}
    >
      <div className="flex min-w-0 flex-col gap-4">
        {tab === 'rules' && search.prompt !== undefined ? (
          <EffectivePromptPanel
            key={repoKeys.length ? 'repos' : 'loading'}
            repos={
              search.prompt && !repoKeys.includes(search.prompt)
                ? [search.prompt, ...repoKeys]
                : repoKeys
            }
            {...(promptRepo ? { repo: promptRepo } : {})}
            onClose={togglePrompt}
          />
        ) : null}
        {tab === 'rules' ? (
          <RulesTab
            selected={search.rule}
            creating={creating ? everything : undefined}
            onOpen={open('rule')}
            onCloseCreating={() => setCreating(false)}
          />
        ) : (
          <LearningsTab
            selected={search.learning}
            creating={creating ? everything : undefined}
            onOpen={open('learning')}
            onCloseCreating={() => setCreating(false)}
          />
        )}
      </div>
      {sheet}
    </Page>
  )
}
