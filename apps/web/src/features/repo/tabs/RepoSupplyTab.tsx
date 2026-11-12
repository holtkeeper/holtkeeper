import type { RepoRef } from '@holtkeeper/api'
import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { useRepos } from '../../../api/queries.ts'
import {
  type SupplySection,
  cardLabels,
  pickTab,
  supplySections,
  visibleTabs,
} from '../../../lib/repo-page.ts'
import { repoKey } from '../../../lib/repo.ts'
import { LinkButton, Segmented } from '../../../ui/index.ts'
import { RepoLibraries } from '../../libraries/LibrariesPage.tsx'
import { RepoLicenses } from '../../licenses/LicensesPage.tsx'
import { RepoPublicApi } from '../../public-api/PublicApiPage.tsx'
import { RepoSecurity } from '../../security/SecurityPage.tsx'
import { useSession } from '../../shell/session.ts'
import { RepoStack } from '../../stack/StackPage.tsx'

function Workspace({ section, repo }: { section: SupplySection; repo: RepoRef }) {
  const key = repoKey(repo)
  const repos = useRepos(section === 'stack')
  const groups = repos.data?.repos.find((summary) => repoKey(summary.repo) === key)?.groups ?? []
  const link =
    section === 'security'
      ? ({ to: '/supply/security', search: { repo: key } } as const)
      : section === 'libraries'
        ? ({ to: '/supply/libraries', search: { repo: key } } as const)
        : section === 'licenses'
          ? ({ to: '/supply/licenses', search: { repo: key } } as const)
          : section === 'stack'
            ? { to: '/supply/stack' as const, search: groups.length ? { group: groups } : {} }
            : ({ to: '/supply/public-api', search: { repo: key } } as const)
  return (
    <LinkButton {...link} variant="ghost" size="sm">
      Open in Supply › {cardLabels[section]}
      <ArrowRight className="size-3.5" />
    </LinkButton>
  )
}

const bodies: Record<SupplySection, (props: { repo: RepoRef }) => ReactNode> = {
  security: RepoSecurity,
  libraries: RepoLibraries,
  licenses: RepoLicenses,
  stack: RepoStack,
  'public-api': RepoPublicApi,
}

/**
 * The hub's Supply chain tab: one area at a time (`section`: security, libraries, licenses, stack
 * or public API), each the Supply page's body narrowed to the repository, with a link to that page.
 */
export function RepoSupplyTab({
  repo,
  section,
  onSection,
}: {
  repo: RepoRef
  section: string | undefined
  onSection: (section: SupplySection) => void
}) {
  const { can } = useSession()
  const sections = visibleTabs(supplySections, can)
  const current = pickTab(sections, section)
  if (!current) return null
  const Current = bodies[current]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          aria-label="Supply chain areas"
          options={sections.map(({ id, label }) => ({ id, label }))}
          value={current}
          onChange={onSection}
        />
        <Workspace section={current} repo={repo} />
      </div>
      <Current key={current} repo={repo} />
    </div>
  )
}
