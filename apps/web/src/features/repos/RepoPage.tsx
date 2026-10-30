import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'

import { useRepos } from '../../api/queries.ts'
import { analysisPages } from '../../lib/analyses.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { Chip, EmptyState, LinkButton, Page, Tabs } from '../../ui/index.ts'
import { BackfillReleasesButton } from '../analyses/BackfillReleases.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { ScopedKnowledge } from '../knowledge/ScopedKnowledge.tsx'
import { MediaButton } from '../media/MediaDialog.tsx'
import { ScopedSettings } from '../settings/ScopedSettings.tsx'
import { useSession } from '../shell/session.ts'
import { RepoAvatarEditor } from './RepoAvatar.tsx'
import { RepoConfig } from './RepoConfig.tsx'
import { RepoUpdates } from './RepoUpdates.tsx'

/** One repository: its groups, settings made for it and the knowledge agents read there. */
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
  const focus = { kind: 'repo' as const, repo }
  const tabs = [
    ...(can('settings:read')
      ? [
          {
            id: 'settings',
            label: 'Settings',
            content: <ScopedSettings focus={focus} groups={allGroups} />,
          },
        ]
      : []),
    ...(can('settings:read')
      ? [
          {
            id: 'updates',
            label: 'Updates',
            content: (
              <RepoUpdates
                repo={repo}
                onOpenSettings={() =>
                  void navigate({
                    search: (previous) => ({ ...previous, tab: 'settings' }),
                    replace: true,
                  })
                }
              />
            ),
          },
        ]
      : []),
    ...(can('knowledge:read')
      ? [
          {
            id: 'knowledge',
            label: 'Knowledge',
            content: <ScopedKnowledge focus={focus} groups={allGroups} />,
          },
        ]
      : []),
    { id: 'config', label: 'Config', content: <RepoConfig repo={repo} /> },
  ]
  const selected = tabs.some((t) => t.id === search.tab) ? search.tab : tabs[0]?.id

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
          {repo.forge}
          {groups.map((group) => (
            <Link key={group} to="/repos/groups/$groupId" params={{ groupId: group }}>
              <Chip className="hover:underline">group {group}</Chip>
            </Link>
          ))}
          {repos.isSuccess && !summary ? <Chip tone="warning">not in any group</Chip> : null}
        </span>
      }
      actions={
        <>
          <RunJobButton repo={repo} />
          <BackfillReleasesButton repo={repo} variant="ghost" />
          <MediaButton repo={repo} />
          {can('analyses:read') ? (
            <LinkButton to="/jobs" search={{ repo: repoKey(repo) }} variant="ghost">
              Jobs
            </LinkButton>
          ) : null}
          {summary?.latestAudit ? (
            <LinkButton
              to="/audits/$runId"
              params={{ runId: summary.latestAudit.id }}
              variant="ghost"
            >
              Latest audit
            </LinkButton>
          ) : null}
          {can('analyses:read')
            ? analysisPages.map((analysis) => (
                <LinkButton
                  key={analysis.to}
                  to={analysis.to}
                  search={{ repo: repoKey(repo) }}
                  variant="ghost"
                >
                  {analysis.title}
                </LinkButton>
              ))
            : null}
        </>
      }
    >
      {tabs.length ? (
        <Tabs
          aria-label="Repository sections"
          {...(selected ? { selected } : {})}
          onSelect={(tab) =>
            void navigate({ search: (previous) => ({ ...previous, tab }), replace: true })
          }
          items={tabs}
        />
      ) : null}
    </Page>
  )
}
