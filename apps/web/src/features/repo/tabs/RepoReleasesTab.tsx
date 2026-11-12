import type { RepoRef } from '@holtkeeper/api'
import { GitBranch, ListTree } from 'lucide-react'

import { repoKey } from '../../../lib/repo.ts'
import { LinkButton } from '../../../ui/index.ts'
import { ReleaseTimelineView } from '../../releases/ReleaseTimelinePage.tsx'

/** The hub's Releases tab: the repository's release timeline, with links to its Releases pages. */
export function RepoReleasesTab({ repo }: { repo: RepoRef }) {
  const search = { repo: repoKey(repo) }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <LinkButton to="/releases/timeline" search={search} variant="ghost" size="sm">
          <ListTree className="size-3.5" />
          Open in Releases › Timeline
        </LinkButton>
        <LinkButton to="/releases/setup" search={search} variant="ghost" size="sm">
          <GitBranch className="size-3.5" />
          Flow setup
        </LinkButton>
      </div>
      <ReleaseTimelineView repo={repo} />
    </div>
  )
}
