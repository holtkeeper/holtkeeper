import type { RepoRef } from '@holtkeeper/api'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Copy, FolderGit2 } from 'lucide-react'

import { useRepoOverview, useRepoUpdates, useRepos } from '../../api/queries.ts'
import { cellTones } from '../../lib/home.ts'
import { hubSearch, pickTab, repoTabs, updatesBadge, visibleTabs } from '../../lib/repo-page.ts'
import {
  type RepoHubSearch,
  type RepoHubTab,
  parseRepoSplat,
  repoKey,
  repoSplat,
  splitRepoPath,
} from '../../lib/repo.ts'
import { Dot, EmptyState, Page, SegmentedTabs, Tag, notify } from '../../ui/index.ts'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { RepoActivityTab } from '../repo/tabs/RepoActivityTab.tsx'
import { RepoKnowledgeTab } from '../repo/tabs/RepoKnowledgeTab.tsx'
import { RepoOverviewTab } from '../repo/tabs/RepoOverviewTab.tsx'
import { RepoQualityTab } from '../repo/tabs/RepoQualityTab.tsx'
import { RepoReleasesTab } from '../repo/tabs/RepoReleasesTab.tsx'
import { RepoSettingsTab } from '../repo/tabs/RepoSettingsTab.tsx'
import { RepoSupplyTab } from '../repo/tabs/RepoSupplyTab.tsx'
import { RepoNotFound } from '../shell/NotFound.tsx'
import { useSession } from '../shell/session.ts'
import { RepoAvatarEditor } from './RepoAvatar.tsx'
import { RepoHealthStrip } from './RepoOverview.tsx'

/** The header's Updates tag; it opens the Updates area of the Settings tab. */
function UpdatesTag({ repo }: { repo: RepoRef }) {
  const updates = useRepoUpdates(repo)
  if (!updates.isSuccess) return null
  const badge = updatesBadge(updates.data)
  return (
    <Link
      to="/repos/$"
      params={{ _splat: repoSplat(repo) }}
      search={hubSearch('settings', 'updates')}
      aria-label={`Updates: ${badge.text}`}
      className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-line-strong bg-panel px-2.5 text-[12.5px] font-medium text-foreground no-underline hover:bg-raise"
    >
      <Dot tone={cellTones[badge.tone]} />
      Updates
      <span className="font-normal text-muted">{badge.text}</span>
    </Link>
  )
}

function Heading({
  repo,
  groups,
  defaultBranch,
  writable,
}: {
  repo: RepoRef
  groups: readonly string[]
  defaultBranch: string | undefined
  writable: boolean
}) {
  const { namespace, name } = splitRepoPath(repo.path)
  return (
    <span className="flex min-w-0 items-center gap-3">
      <RepoAvatarEditor repo={repo} writable={writable} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[16px]">
          <span className="font-medium text-muted">{namespace}</span>
          {name}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs font-normal">
          <span className="mono text-muted">{repo.forge}</span>
          {defaultBranch ? (
            <>
              <span className="text-dim">·</span>
              <span className="mono text-muted">{defaultBranch}</span>
            </>
          ) : null}
          {groups.length ? (
            <>
              <span className="text-dim">·</span>
              <span className="text-muted">Groups</span>
              {groups.map((group) => (
                <Link
                  key={group}
                  to="/repos/groups/$groupId"
                  params={{ groupId: group }}
                  className="no-underline"
                >
                  <Tag>{group}</Tag>
                </Link>
              ))}
            </>
          ) : null}
        </span>
      </span>
    </span>
  )
}

function Hub({
  repo,
  groups,
  allGroups,
  search,
}: {
  repo: RepoRef
  groups: readonly string[]
  allGroups: readonly string[]
  search: RepoHubSearch
}) {
  const { can } = useSession()
  const navigate = useNavigate({ from: '/repos/$' })
  const run = useRunJob({ repo })
  const canAnalyses = can('analyses:read')
  const query = useRepoOverview(repo, canAnalyses)
  const overview = canAnalyses ? query : undefined
  const tabs = visibleTabs(repoTabs, can)
  const tab = pickTab(tabs, search.tab)
  const go = (next: RepoHubTab, section?: string) =>
    void navigate({ search: hubSearch(next, section), replace: true })
  const known = groups.length ? groups : (overview?.data?.groups ?? [])

  return (
    <Page
      crumbs={[
        {
          label: <span className="mono">{repo.path}</span>,
          link: { to: '/repos/$', params: { _splat: repoSplat(repo) } },
        },
        { label: tabs.find((entry) => entry.id === tab)?.label ?? 'Repository' },
      ]}
      tabs={false}
      title={
        <Heading
          repo={repo}
          groups={known}
          defaultBranch={overview?.data?.defaultBranch}
          writable={can('settings:write')}
        />
      }
      actions={can('settings:read') ? <UpdatesTag repo={repo} /> : null}
      more={[
        {
          label: 'Copy path',
          icon: Copy,
          onAction: () =>
            void navigator.clipboard
              .writeText(repo.path)
              .then(() => notify.success('Copied', repo.path)),
        },
      ]}
      {...(run.action ? { primary: run.action } : {})}
    >
      <div className="-mx-4 -mt-4 flex flex-col">
        {tabs.length ? (
          <div className="border-b border-line px-3.5 py-2.5">
            <SegmentedTabs
              aria-label="Repository sections"
              items={tabs.map(({ id, label }) => ({
                id,
                label,
                link: {
                  to: '/repos/$',
                  params: { _splat: repoSplat(repo) },
                  search: hubSearch(id),
                },
              }))}
              {...(tab ? { selected: tab } : {})}
            />
          </div>
        ) : null}
        {overview ? <RepoHealthStrip overview={overview.data} /> : null}
      </div>
      {tab === 'overview' && overview ? <RepoOverviewTab repo={repo} overview={overview} /> : null}
      {tab === 'supply' ? (
        <RepoSupplyTab
          repo={repo}
          section={search.section}
          onSection={(section) => go('supply', section)}
        />
      ) : null}
      {tab === 'quality' && overview ? (
        <RepoQualityTab
          repo={repo}
          section={search.section}
          {...(search.file ? { file: search.file } : {})}
          {...(search.ref ? { gitRef: search.ref } : {})}
          onSection={(section) => go('quality', section)}
        />
      ) : null}
      {tab === 'releases' ? <RepoReleasesTab repo={repo} /> : null}
      {tab === 'activity' ? <RepoActivityTab repo={repo} /> : null}
      {tab === 'knowledge' ? <RepoKnowledgeTab repo={repo} /> : null}
      {tab === 'settings' ? (
        <RepoSettingsTab
          repo={repo}
          allGroups={allGroups}
          {...(search.section ? { section: search.section } : {})}
        />
      ) : null}
      {run.dialog}
    </Page>
  )
}

/**
 * The repository hub: header with avatar, path, forge, default branch, groups and the Updates tag,
 * the health strip, then the tabs Overview, Supply chain, Quality, Releases, Activity, Knowledge and
 * Settings as the `tab`, `section`, `file` and `ref` search parameters choose. The overview behind
 * the strip and the first three tabs is read only with `analyses:read`.
 */
export function RepoPage() {
  const { _splat } = useParams({ from: '/app/repos/$' })
  const search = useSearch({ from: '/app/repos/$' })
  const repos = useRepos()
  const repo = parseRepoSplat(_splat)

  if (!repo)
    return (
      <Page crumbs={[{ label: 'Repository' }]} title="Repository" tabs={false}>
        <EmptyState icon={<FolderGit2 />} title="No repository chosen" />
      </Page>
    )

  const summary = repos.data?.repos.find((r) => repoKey(r.repo) === repoKey(repo))
  if (repos.isSuccess && !summary) return <RepoNotFound repo={repoKey(repo)} />
  const props = {
    repo,
    groups: summary?.groups ?? [],
    allGroups: [...new Set((repos.data?.repos ?? []).flatMap((r) => r.groups))].toSorted(),
    search,
  }
  return <Hub key={repoKey(repo)} {...props} />
}
