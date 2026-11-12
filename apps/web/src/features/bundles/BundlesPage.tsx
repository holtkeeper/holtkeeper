import { useNavigate, useSearch } from '@tanstack/react-router'
import { X } from 'lucide-react'

import { type BundlesSearch } from '../../lib/bundles.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { patchSearch } from '../../lib/search-params.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import { Button, Page } from '../../ui/index.ts'
import { useBackfillReleases } from '../analyses/BackfillReleases.tsx'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { BundlesBody } from './BundlesBody.tsx'

/** Quality › Bundles: the newest size of every app build and published package, against its budget. */
export function BundlesPage() {
  const search = useSearch({ from: '/app/quality/bundles' })
  const navigate = useNavigate({ from: '/quality/bundles' })
  const update = (patch: Partial<BundlesSearch>) =>
    void navigate({ search: (prev) => patchSearch(prev, patch), replace: true })
  const repo = parseRepoKey(search.repo)
  const settings = useConfigure('Bundle settings', pageSettingKeys.bundles)
  const run = useRunJob({ analyzer: 'bundle', label: 'Measure now', ...(repo ? { repo } : {}) })
  const backfill = useBackfillReleases('bundle', repo)
  return (
    <Page
      crumbs={[{ label: 'Bundles' }]}
      description={
        repo
          ? `App builds and published packages of ${repoKey(repo)}`
          : 'App builds and published packages: newest size against the budget'
      }
      search={{
        value: search.q ?? '',
        onChange: (q) => update({ q: q || undefined }),
        'aria-label': 'Filter build targets',
        placeholder: 'Filter by repository or target',
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
      {...(backfill.item ? { more: [backfill.item] } : {})}
    >
      <BundlesBody search={search} update={update} />
      {settings.sheet}
      {run.dialog}
      {backfill.dialog}
    </Page>
  )
}
