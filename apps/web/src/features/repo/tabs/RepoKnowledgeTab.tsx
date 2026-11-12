import type { RepoRef } from '@holtkeeper/api'

import { ScopeGuide } from '../../repos/ScopeGuide.tsx'

/** The hub's Knowledge tab: the repository's resolved Guide and its own sections. */
export function RepoKnowledgeTab({ repo }: { repo: RepoRef }) {
  return <ScopeGuide space={{ kind: 'repo', repo }} />
}
