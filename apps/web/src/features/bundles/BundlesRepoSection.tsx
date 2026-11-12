import type { RepoRef } from '@holtkeeper/api'
import { useState } from 'react'

import { type BundlesSearch } from '../../lib/bundles.ts'
import { repoKey } from '../../lib/repo.ts'
import { patchSearch } from '../../lib/search-params.ts'
import { LinkButton } from '../../ui/index.ts'
import { BundlesBody } from './BundlesBody.tsx'

/** The hub's Quality › Bundles section: the Bundles table narrowed to one repository, with its sheet. */
export function BundlesRepoSection({ repo }: { repo: RepoRef }) {
  const [search, setSearch] = useState<BundlesSearch>({})
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <LinkButton
          to="/quality/bundles"
          search={{ repo: repoKey(repo) }}
          variant="ghost"
          size="sm"
        >
          Open in Quality
        </LinkButton>
      </div>
      <BundlesBody
        repo={repo}
        search={search}
        update={(patch) => setSearch((prev) => patchSearch(prev, patch))}
      />
    </div>
  )
}
