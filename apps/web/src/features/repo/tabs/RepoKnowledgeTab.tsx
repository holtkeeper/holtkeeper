import type { RepoRef } from '@holtkeeper/api'

import { EffectivePromptPanel } from '../../knowledge/EffectivePrompt.tsx'
import { ScopedLearnings, ScopedRules } from '../../knowledge/ScopedKnowledge.tsx'

/** The hub's Knowledge tab: the repository's effective prompt, the rules and the learnings that apply to it. */
export function RepoKnowledgeTab({ repo }: { repo: RepoRef }) {
  return (
    <div className="flex flex-col gap-5">
      <EffectivePromptPanel repo={repo} />
      <ScopedRules query={{ repo }} title="Rules" />
      <ScopedLearnings repo={repo} />
    </div>
  )
}
