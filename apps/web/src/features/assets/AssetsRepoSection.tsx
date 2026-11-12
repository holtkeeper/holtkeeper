import type { RepoRef } from '@holtkeeper/api'
import { useState } from 'react'

import { useRepoAssets } from '../../api/queries.ts'
import { type AssetsSearch, policyLines, policySource } from '../../lib/assets.ts'
import { formatRelative } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import { patchSearch } from '../../lib/search-params.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import { LinkButton, SearchInput, Tag } from '../../ui/index.ts'
import { PolicyBlock } from '../knowledge/PolicyBlock.tsx'
import { SettingsButton } from '../settings/SettingsSheet.tsx'
import { AssetsFiles } from './AssetsFiles.tsx'
import { AssetsPolicyCard } from './AssetsPolicyCard.tsx'

/**
 * The hub's Quality › Assets section: the repository's asset files to act on with the media
 * optimizer, and its effective policy with where it comes from and its own entries. `file` at
 * `ref` opens the optimizer on that file, which is where review comments link.
 */
export function AssetsRepoSection({
  repo,
  file,
  ref,
}: {
  repo: RepoRef
  file?: string
  ref?: string
}) {
  const view = useRepoAssets(repo)
  const [search, setSearch] = useState<AssetsSearch>({})
  const update = (patch: Partial<AssetsSearch>) => setSearch((prev) => patchSearch(prev, patch))
  const data = view.data
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          aria-label="Filter files"
          value={search.q ?? ''}
          onChange={(q) => update({ q: q || undefined })}
          placeholder="Filter by path or format"
          className="w-64 max-w-full"
        />
        {data?.createdAt ? (
          <span className="text-xs text-dim">
            checked {formatRelative(data.createdAt)}
            {data.sha ? <span className="mono"> · {data.sha.slice(0, 8)}</span> : null}
          </span>
        ) : null}
        {data && data.summary && !data.checkedPolicy ? (
          <Tag tone="info">checked before the policy existed</Tag>
        ) : null}
        <span className="flex-1" />
        <LinkButton to="/quality/assets" search={{ repo: repoKey(repo) }} variant="ghost" size="sm">
          Open in Quality
        </LinkButton>
      </div>
      <AssetsFiles
        repo={repo}
        search={search}
        update={update}
        trend={data?.trend.map((point) => point.totalBytes) ?? []}
        {...(file ? { media: { repo, file, ...(ref ? { ref } : {}) } } : {})}
      />
      {data ? (
        <AssetsPolicyCard
          lines={policyLines(data.policy)}
          source={policySource(data.policySource)}
          space={`repo:${repoKey(repo)}`}
          actions={
            <SettingsButton
              title="Assets analyzer settings"
              keys={pageSettingKeys.assets}
              label="Analyzer options"
            />
          }
        >
          <PolicyBlock settingKey="assets.policy" space={{ kind: 'repo', repo }} members={[]} />
        </AssetsPolicyCard>
      ) : null}
    </div>
  )
}
