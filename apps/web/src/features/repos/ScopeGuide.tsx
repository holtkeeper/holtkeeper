import type { GuideTask } from '@holtkeeper/api'
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { guideTasks, type Space, spaceKey } from '../../lib/guide.ts'
import { LinkButton, Segmented } from '../../ui/index.ts'
import { GuideTab } from '../knowledge/GuideTab.tsx'
import { EffectivePrompt } from '../knowledge/PreviewSheet.tsx'

/**
 * A repository's or group's Guide: for a repository first the text its tasks get with every layer
 * resolved, then the sections of its own scope to edit; Notes and Learnings stay on Knowledge.
 */
export function ScopeGuide({ space }: { space: Extract<Space, { kind: 'repo' | 'group' }> }) {
  const [task, setTask] = useState<GuideTask>('review')
  return (
    <div className="flex flex-col gap-4">
      {space.kind === 'repo' ? (
        <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold">Resolved guide</h2>
            <Segmented aria-label="Task" options={guideTasks} value={task} onChange={setTask} />
          </div>
          <EffectivePrompt repo={space.repo} task={task} />
        </section>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">
          {space.kind === 'repo' ? 'This repository’s sections' : 'This group’s sections'}
        </h2>
        <LinkButton
          to="/knowledge"
          search={{ space: spaceKey(space), tab: 'notes' }}
          variant="ghost"
          size="sm"
        >
          Notes and learnings
          <ExternalLink className="size-3.5" />
        </LinkButton>
      </div>
      <GuideTab space={space} families={[]} />
    </div>
  )
}
