import type { GuideSectionName } from '@holtkeeper/api'
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { type Space, spaceKey } from '../../lib/guide.ts'
import { repoKey } from '../../lib/repo.ts'
import { LinkButton } from '../../ui/index.ts'
import { EffectivePromptPanel } from '../knowledge/EffectivePrompt.tsx'
import { GuideTab } from '../knowledge/GuideTab.tsx'

/**
 * A repository's or group's Guide inside its hub: the sections table with the layers of the
 * picked section in agent reading order, and for a repository the effective prompt its tasks get.
 * Notes and Learnings stay on Knowledge.
 */
export function ScopeGuide({ space }: { space: Extract<Space, { kind: 'repo' | 'group' }> }) {
  const [section, setSection] = useState<GuideSectionName | undefined>()
  const [prompt, setPrompt] = useState(space.kind === 'repo')
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">
          {space.kind === 'repo' ? 'Guide of this repository' : 'Guide of this group'}
        </h2>
        <LinkButton
          to="/knowledge/notes"
          search={{ space: spaceKey(space) }}
          variant="ghost"
          size="sm"
        >
          Notes and learnings
          <ExternalLink className="size-3.5" />
        </LinkButton>
      </div>
      {space.kind === 'repo' && prompt ? (
        <EffectivePromptPanel
          repos={[repoKey(space.repo)]}
          initial={space.repo}
          onClose={() => setPrompt(false)}
        />
      ) : null}
      <GuideTab space={space} families={[]} section={section} onSection={setSection} />
    </div>
  )
}
