import type { RepoRef } from '@holtkeeper/api'

import { type QualitySection, pickTab, qualitySections } from '../../../lib/repo-page.ts'
import { Segmented } from '../../../ui/index.ts'
import { AssetsRepoSection } from '../../assets/AssetsRepoSection.tsx'
import { BranchesRepoSection } from '../../branches/BranchesRepoSection.tsx'
import { BundlesRepoSection } from '../../bundles/BundlesRepoSection.tsx'
import { CiRepoSection } from '../../ci/CiRepoSection.tsx'
import { ReviewsRepoSection } from '../../reviews/ReviewsRepoSection.tsx'
import { CoverageRepoSection } from '../../test-coverage/CoverageRepoSection.tsx'

/**
 * The hub's Quality tab, one area at a time (`section`), each the area's own repository section;
 * `file` at `gitRef` opens that file in Assets.
 */
export function RepoQualityTab({
  repo,
  section,
  file,
  gitRef,
  onSection,
}: {
  repo: RepoRef
  section: string | undefined
  file?: string
  gitRef?: string
  onSection: (section: QualitySection) => void
}) {
  const current = pickTab(qualitySections, section) ?? 'coverage'
  return (
    <div className="flex flex-col gap-4">
      <Segmented
        aria-label="Quality areas"
        options={qualitySections.map(({ id, label }) => ({ id, label }))}
        value={current}
        onChange={onSection}
      />
      {current === 'coverage' ? <CoverageRepoSection repo={repo} /> : null}
      {current === 'bundles' ? <BundlesRepoSection repo={repo} /> : null}
      {current === 'assets' ? (
        <AssetsRepoSection
          repo={repo}
          {...(file ? { file } : {})}
          {...(gitRef ? { ref: gitRef } : {})}
        />
      ) : null}
      {current === 'ci' ? <CiRepoSection repo={repo} /> : null}
      {current === 'branches' ? <BranchesRepoSection repo={repo} /> : null}
      {current === 'reviews' ? <ReviewsRepoSection repo={repo} /> : null}
    </div>
  )
}
