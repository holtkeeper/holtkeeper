import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'

import { useRepos } from '../../api/queries.ts'
import { pickTab, repoTabs, visibleTabs } from '../../lib/repo-page.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { EmptyState, Page, SegmentedTabs, Tag } from '../../ui/index.ts'
import { AssetsTab } from '../assets/AssetsTab.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { ScopedSettings } from '../settings/ScopedSettings.tsx'
import { useSession } from '../shell/session.ts'
import { RepoAvatarEditor } from './RepoAvatar.tsx'
import { RepoOverview } from './RepoOverview.tsx'
import { RepoReviews } from './RepoReviews.tsx'
import { UpdatesTag } from './RepoUpdates.tsx'
import { ScopeGuide } from './ScopeGuide.tsx'

/** One repository: Overview cards, its Guide, assets, Holtkeeper's reviews and its overrides. */
export function RepoPage() {
  const { can } = useSession()
  const search = useSearch({ from: '/app/repos/view' })
  const navigate = useNavigate({ from: '/repos/view' })
  const repos = useRepos()
  const repo = parseRepoKey(search.repo)

  if (!repo)
    return (
      <Page title="Repository">
        <EmptyState icon={<FolderGit2 />} title="No repository chosen" />
      </Page>
    )

  const summary = repos.data?.repos.find((r) => repoKey(r.repo) === repoKey(repo))
  const groups = summary?.groups ?? []
  const allGroups = [...new Set((repos.data?.repos ?? []).flatMap((r) => r.groups))].toSorted()
  const tabs = visibleTabs(repoTabs, can)
  const tab = pickTab(tabs, search.tab)
  const go = (next: string) =>
    void navigate({
      search: (previous) => ({
        repo: previous.repo,
        ...(next === tabs[0]?.id ? {} : { tab: next }),
      }),
      replace: true,
    })

  return (
    <Page
      eyebrow={
        <Link to="/repos" className="hover:underline">
          Repositories
        </Link>
      }
      media={<RepoAvatarEditor repo={repo} writable={can('settings:write')} />}
      title={repo.path}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="mono">{repo.forge}</span>
          {groups.map((group) => (
            <Link key={group} to="/repos/groups/$groupId" params={{ groupId: group }}>
              <Tag className="hover:underline">group {group}</Tag>
            </Link>
          ))}
          {repos.isSuccess && !summary ? <Tag tone="warning">not in any group</Tag> : null}
          {can('settings:read') ? (
            <UpdatesTag repo={repo} onOpenSettings={() => go('settings')} />
          ) : null}
        </span>
      }
      actions={<RunJobButton repo={repo} />}
    >
      {tabs.length ? (
        <SegmentedTabs
          aria-label="Repository sections"
          items={tabs.map(({ id, label }) => ({ id, label }))}
          {...(tab ? { selected: tab } : {})}
          onSelect={go}
          className="self-start"
        />
      ) : null}
      {tab === 'overview' ? <RepoOverview repo={repo} onAssets={() => go('assets')} /> : null}
      {tab === 'guide' ? <ScopeGuide space={{ kind: 'repo', repo }} /> : null}
      {tab === 'assets' ? (
        <AssetsTab
          repo={repo}
          {...(search.file ? { file: search.file } : {})}
          {...(search.ref ? { ref: search.ref } : {})}
        />
      ) : null}
      {tab === 'reviews' ? <RepoReviews repo={repo} /> : null}
      {tab === 'settings' ? (
        <ScopedSettings focus={{ kind: 'repo', repo }} groups={allGroups} focusGroups={groups} />
      ) : null}
    </Page>
  )
}
