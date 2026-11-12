import { useNavigate, useSearch } from '@tanstack/react-router'
import { Users, X } from 'lucide-react'

import { type BranchesSearch } from '../../lib/branches.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { patchSearch } from '../../lib/search-params.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import { Button, Page } from '../../ui/index.ts'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { BranchesBody } from './BranchesBody.tsx'

/** Quality › Branches: merged, abandoned and stale branches worth deleting, read-only. */
export function BranchesPage() {
  const search = useSearch({ from: '/app/quality/branches' })
  const navigate = useNavigate({ from: '/quality/branches' })
  const update = (patch: Partial<BranchesSearch>) =>
    void navigate({ search: (prev) => patchSearch(prev, patch), replace: true })
  const repo = parseRepoKey(search.repo)
  const settings = useConfigure('Branch settings', pageSettingKeys.branches)
  const run = useRunJob({ analyzer: 'branches', label: 'Run now', ...(repo ? { repo } : {}) })
  return (
    <Page
      crumbs={[{ label: 'Branches' }]}
      description={
        repo
          ? `Branches worth deleting in ${repoKey(repo)}`
          : 'Merged, abandoned and stale branches worth deleting'
      }
      search={{
        value: search.q ?? '',
        onChange: (q) => update({ q: q || undefined }),
        'aria-label': 'Filter branches',
        placeholder: 'Filter by branch, repository or author',
      }}
      {...(repo
        ? {
            filters: (
              <Button size="sm" variant="secondary" onPress={() => update({ repo: undefined })}>
                Repository: <span className="mono">{repo.path}</span>
                <X aria-label="Clear repository" className="size-3.5" />
              </Button>
            ),
          }
        : {})}
      configure={settings.configure}
      primary={run.action}
      more={[
        { label: 'By author', icon: Users, onAction: () => update({ panel: 'authors' }) },
        { label: 'Since last run', onAction: () => update({ panel: 'changes' }) },
      ]}
    >
      <BranchesBody search={search} update={update} />
      {settings.sheet}
      {run.dialog}
    </Page>
  )
}
