import type { RepoRef } from '@holtkeeper/api'
import { useNavigate } from '@tanstack/react-router'

import { hubSearch } from '../../../lib/repo-page.ts'
import { ResolvedSettings } from '../../settings/ResolvedSettings.tsx'

/**
 * The hub's Settings tab: the settings resolver for the repository. `section` (e.g. `updates`)
 * picks a category and stays in the URL.
 */
export function RepoSettingsTab({
  repo,
  allGroups,
  section,
}: {
  repo: RepoRef
  /** Every known group, offered in the scope editor. */
  allGroups: readonly string[]
  section?: string
}) {
  const navigate = useNavigate({ from: '/repos/$' })
  return (
    <ResolvedSettings
      focus={{ kind: 'repo', repo }}
      groups={allGroups}
      section={section}
      onSection={(next) => void navigate({ search: hubSearch('settings', next), replace: true })}
    />
  )
}
