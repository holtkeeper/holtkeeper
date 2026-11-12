import type { RepoRef } from '@holtkeeper/api'
import { GitPullRequestArrow } from 'lucide-react'
import { useState } from 'react'

import { repoKey } from '../../lib/repo.ts'
import type { ReviewsSearch } from '../../lib/reviews.ts'
import { patchSearch } from '../../lib/search-params.ts'
import { Button, LinkButton } from '../../ui/index.ts'
import { ReviewMergeRequestDialog, useCanReview } from './ReviewDialogs.tsx'
import { ReviewsBody } from './ReviewsPage.tsx'

/** The hub's Quality › Reviews section: Holtkeeper's reviews of the repository, with the sheet. */
export function ReviewsRepoSection({ repo }: { repo: RepoRef }) {
  const [search, setSearch] = useState<ReviewsSearch>({})
  const canReview = useCanReview()
  const [asking, setAsking] = useState(false)
  const update = (patch: Partial<ReviewsSearch>) => setSearch((prev) => patchSearch(prev, patch))
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        <LinkButton
          to="/quality/reviews"
          search={{ repo: repoKey(repo) }}
          variant="ghost"
          size="sm"
        >
          Open in Quality
        </LinkButton>
        {canReview ? (
          <Button size="sm" variant="secondary" onPress={() => setAsking(true)}>
            <GitPullRequestArrow className="size-3.5" />
            Review a merge request
          </Button>
        ) : null}
      </div>
      <ReviewsBody repo={repo} search={search} update={update} />
      <ReviewMergeRequestDialog isOpen={asking} onOpenChange={setAsking} repo={repo} />
    </div>
  )
}
