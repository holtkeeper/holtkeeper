import type { RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'

import { repoKey, splitRepoPath } from '../../lib/repo.ts'
import { RepoAvatar } from './RepoAvatar.tsx'

/** Repository avatar and name linking to a per-repository page keyed by `forge:path`. */
export function RepoLink({ repo, to }: { repo: RepoRef; to: '/ci/$' | '/releases/$' }) {
  const { namespace, name } = splitRepoPath(repo.path)
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <RepoAvatar repo={repo} size="sm" />
      <Link
        to={to}
        params={{ _splat: repoKey(repo) }}
        className="min-w-0 truncate hover:underline"
        title={repo.path}
      >
        <span className="text-muted">{namespace}</span>
        <span className="font-semibold">{name}</span>
      </Link>
    </div>
  )
}
