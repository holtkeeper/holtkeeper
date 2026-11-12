import type { RepoRef } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ImageDown, X } from 'lucide-react'
import { useState } from 'react'

import { useRepoAssets, useSettings } from '../../api/queries.ts'
import {
  type AssetsSearch,
  fleetPolicy,
  overridesText,
  policyLines,
  policySource,
} from '../../lib/assets.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { patchSearch } from '../../lib/search-params.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import { Button, Page } from '../../ui/index.ts'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useSession } from '../shell/session.ts'
import { AssetsFiles } from './AssetsFiles.tsx'
import { AssetsPolicyCard } from './AssetsPolicyCard.tsx'

function EditPolicy({ onPress }: { onPress: (() => void) | undefined }) {
  return onPress ? (
    <Button variant="secondary" size="sm" onPress={onPress}>
      Edit
    </Button>
  ) : null
}

function RepoPolicy({ repo, onEdit }: { repo: RepoRef; onEdit: (() => void) | undefined }) {
  const assets = useRepoAssets(repo)
  if (!assets.data) return null
  return (
    <AssetsPolicyCard
      lines={policyLines(assets.data.policy)}
      source={policySource(assets.data.policySource)}
      space={`repo:${repoKey(repo)}`}
      actions={<EditPolicy onPress={onEdit} />}
    />
  )
}

function FleetPolicy({ onEdit }: { onEdit: (() => void) | undefined }) {
  const { can } = useSession()
  const settings = useSettings(can('settings:read'))
  const fleet = settings.data ? fleetPolicy(settings.data) : undefined
  if (!fleet)
    return can('settings:read') ? null : (
      <p className="text-xs text-muted">
        Narrow the page to a repository to see the asset policy that applies to it.
      </p>
    )
  const overrides = overridesText(fleet.overrides)
  return (
    <AssetsPolicyCard
      lines={policyLines(fleet.policy)}
      source={overrides ? `${fleet.source} · ${overrides}` : fleet.source}
      space="all"
      actions={<EditPolicy onPress={onEdit} />}
    />
  )
}

/**
 * Quality › Assets: images, fonts and media to act on across the repositories you can see, the
 * media optimizer for one file or a selection, and the asset policy.
 */
export function AssetsPage() {
  const search = useSearch({ from: '/app/quality/assets' })
  const navigate = useNavigate({ from: '/quality/assets' })
  const update = (patch: Partial<AssetsSearch>) =>
    void navigate({ search: (prev) => patchSearch(prev, patch), replace: true })
  const repo = parseRepoKey(search.repo)
  const [optimizing, setOptimizing] = useState(false)
  const settings = useConfigure('Assets analyzer settings', pageSettingKeys.assets)
  const policy = useConfigure('Asset policy', ['assets.policy'])
  const run = useRunJob({ analyzer: 'assets', label: 'Run assets', ...(repo ? { repo } : {}) })
  return (
    <Page
      crumbs={[{ label: 'Assets' }]}
      description={
        repo
          ? `Asset files of ${repoKey(repo)} to act on`
          : 'Images, fonts and media to act on across the repositories you can see'
      }
      search={{
        value: search.q ?? '',
        onChange: (q) => update({ q: q || undefined }),
        'aria-label': 'Filter files',
        placeholder: 'Filter by repository, path, format',
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
      primary={{ label: 'Optimize an image', icon: ImageDown, onPress: () => setOptimizing(true) }}
      {...(run.action?.onPress
        ? { more: [{ label: 'Run assets', onAction: run.action.onPress }] }
        : {})}
    >
      <AssetsFiles
        search={search}
        update={update}
        optimizeNew={optimizing}
        onOptimizeNewDone={() => setOptimizing(false)}
      />
      {repo ? (
        <RepoPolicy repo={repo} onEdit={policy.configure?.onPress} />
      ) : (
        <FleetPolicy onEdit={policy.configure?.onPress} />
      )}
      {settings.sheet}
      {policy.sheet}
      {run.dialog}
    </Page>
  )
}
