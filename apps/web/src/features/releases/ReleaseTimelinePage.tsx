import type { ReleaseRepoView } from '@holtkeeper/api'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { GitBranch, ListTree } from 'lucide-react'

import { useReleaseRepo } from '../../api/queries.ts'
import { exampleTag } from '../../lib/release-flow.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { EmptyState, ErrorState, Notice, Page, Placeholder, SegmentedTabs } from '../../ui/index.ts'
import { RepoAvatar } from '../repos/RepoAvatar.tsx'
import { DeployStrip } from './DeployStrip.tsx'
import { FlowTab } from './FlowTab.tsx'
import { NextCard } from './NextCard.tsx'
import { ReleaseLinks, StageTag } from './parts.tsx'
import { VersionList } from './VersionList.tsx'

function flowSummary(view: ReleaseRepoView) {
  const { flow, version } = view.settings
  const target = view.row.target ?? flow.target ?? 'the default branch'
  const tags = exampleTag(version)
  if (flow.mode === 'external') return 'Released by another tool'
  return flow.mode === 'trunk'
    ? `Trunk: versions tagged on ${target} as ${tags}`
    : `${flow.source} → ${target} through a release merge request, tagged as ${tags}`
}

const tabs = [
  { id: 'timeline', label: 'Timeline', icon: ListTree },
  { id: 'flow', label: 'Flow', icon: GitBranch },
] as const

/**
 * One repository's releases: the next version with its actions, the deploys of the latest
 * version and past versions on the Timeline tab; the release flow diagram on the Flow tab.
 */
export function ReleaseTimelinePage() {
  const params = useParams({ strict: false })
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const { _splat: key } = params
  const repo = parseRepoKey(key)
  const view = useReleaseRepo(repo)
  const tab = search.tab === 'flow' ? 'flow' : 'timeline'

  if (!repo)
    return (
      <EmptyState
        title="No repository"
        description={
          <>
            Open a repository from <Link to="/releases">Releases</Link>.
          </>
        }
      />
    )
  const data = view.data
  return (
    <Page
      title={repo.path}
      eyebrow={<Link to="/releases">Releases</Link>}
      media={<RepoAvatar repo={repo} size="lg" />}
      description={data ? flowSummary(data) : undefined}
      actions={
        <>
          {data ? <StageTag row={data.row} /> : null}
          <SegmentedTabs
            aria-label="Release views"
            items={tabs}
            selected={tab}
            onSelect={(id) =>
              void navigate({
                to: '/releases/$',
                params: { _splat: repoKey(repo) },
                search: id === 'flow' ? { tab: 'flow' } : {},
              })
            }
          />
        </>
      }
    >
      {view.isPending ? (
        <div className="flex flex-col gap-3">
          <Placeholder className="h-48" />
          <Placeholder className="h-32" />
        </div>
      ) : view.isError ? (
        <ErrorState error={view.error} />
      ) : data ? (
        <>
          {data.dryRun ? (
            <Notice tone="warning" title="Dry run">
              Steps report what they would do and change nothing.
            </Notice>
          ) : null}
          {data.readOnly ? (
            <Notice tone="warning" title="Read-only">
              Holtkeeper only reads this repository; steps and deploys are off.
            </Notice>
          ) : null}
          {!data.settings.enabled && tab === 'timeline' ? (
            <Notice title="Releases are off for this repository">
              It is left out of the overview and not refreshed on forge events.{' '}
              {data.can.configure ? (
                <Link
                  to="/releases/$"
                  params={{ _splat: repoKey(repo) }}
                  search={{ tab: 'flow' }}
                  className="underline"
                >
                  Set up its flow
                </Link>
              ) : null}
            </Notice>
          ) : null}
          {tab === 'flow' ? (
            <FlowTab repo={repo} view={data} />
          ) : (
            <>
              <ReleaseLinks links={data.links} />
              <NextCard repo={repo} view={data} />
              {data.deploy ? (
                <DeployStrip repo={repo} view={data} tag={data.deploy.tag} initial={data.deploy} />
              ) : null}
              <VersionList repo={repo} view={data} />
            </>
          )}
        </>
      ) : null}
    </Page>
  )
}
