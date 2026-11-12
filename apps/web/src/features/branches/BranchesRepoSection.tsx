import type { RepoRef } from '@holtkeeper/api'
import { useState } from 'react'

import { type BranchesSearch } from '../../lib/branches.ts'
import { repoKey } from '../../lib/repo.ts'
import { patchSearch } from '../../lib/search-params.ts'
import { LinkButton } from '../../ui/index.ts'
import { BranchesBody } from './BranchesBody.tsx'

/** The hub's Quality › Branches section: the Branches table narrowed to one repository, with its sheet. */
export function BranchesRepoSection({ repo }: { repo: RepoRef }) {
  const [search, setSearch] = useState<BranchesSearch>({})
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <LinkButton
          to="/quality/branches"
          search={{ repo: repoKey(repo) }}
          variant="ghost"
          size="sm"
        >
          Open in Quality
        </LinkButton>
      </div>
      <BranchesBody
        repo={repo}
        search={search}
        update={(patch) => setSearch((prev) => patchSearch(prev, patch))}
      />
    </div>
  )
}
