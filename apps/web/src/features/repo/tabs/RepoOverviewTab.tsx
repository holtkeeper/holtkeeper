import type { RepoOverview as Overview, RepoRef } from '@holtkeeper/api'
import type { UseQueryResult } from '@tanstack/react-query'

import { ErrorState, Placeholder } from '../../../ui/index.ts'
import { RepoOverview } from '../../repos/RepoOverview.tsx'

/** The hub's Overview tab over the overview the page already loads for its health strip. */
export function RepoOverviewTab({
  repo,
  overview,
}: {
  repo: RepoRef
  overview: UseQueryResult<Overview>
}) {
  if (overview.isPending)
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-2.5">
        {[0, 1, 2, 3, 4].map((index) => (
          <Placeholder key={index} className="h-36" />
        ))}
      </div>
    )
  if (overview.isError) return <ErrorState error={overview.error} />
  return <RepoOverview repo={repo} overview={overview.data} />
}
