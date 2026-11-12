import type { ReleaseRepoView, RepoRef } from '@holtkeeper/api'
import { Link, Navigate, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { FolderGit2, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useReleaseActions, useReleaseOverview, useReleaseRepo } from '../../api/queries.ts'
import { actionFirst } from '../../lib/release-overview.ts'
import { flowSummary } from '../../lib/release-timeline.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import {
  EmptyState,
  ErrorState,
  Notice,
  Page,
  Placeholder,
  Select,
  notify,
} from '../../ui/index.ts'
import { EnvironmentsPanel } from './DeployStrip.tsx'
import { NextCard } from './NextCard.tsx'
import { ReleaseLinks, StageTag } from './parts.tsx'
import { VersionList } from './VersionList.tsx'

function Body({ repo, data, query }: { repo: RepoRef; data: ReleaseRepoView; query: string }) {
  return (
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
      {!data.settings.enabled ? (
        <Notice title="Releases are off for this repository">
          It is left out of the overview and not refreshed on forge events.{' '}
          {data.can.configure ? (
            <Link to="/releases/setup" search={{ repo: repoKey(repo) }} className="underline">
              Set up its flow
            </Link>
          ) : null}
        </Notice>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StageTag row={data.row} />
        <span className="text-xs text-muted">{flowSummary(data)}</span>
        <span className="flex-1" />
        <ReleaseLinks links={data.links} />
      </div>
      <NextCard repo={repo} view={data} />
      <EnvironmentsPanel repo={repo} view={data} />
      <VersionList repo={repo} view={data} query={query} />
    </>
  )
}

function Loading() {
  return (
    <div className="flex flex-col gap-3">
      <Placeholder className="h-48" />
      <Placeholder className="h-32" />
    </div>
  )
}

/**
 * One repository's release timeline, loading itself: its stage and flow, the next release with
 * its gates and actions, the environments of the latest version and the versions table. `query`
 * narrows the versions table by tag, commit or task key.
 */
export function ReleaseTimelineView({ repo, query = '' }: { repo: RepoRef; query?: string }) {
  const view = useReleaseRepo(repo)
  if (view.isPending) return <Loading />
  if (view.isError) return <ErrorState error={view.error} />
  return (
    <div className="flex flex-col gap-5">
      <Body repo={repo} data={view.data} query={query} />
    </div>
  )
}

function RepoSwitch({ repo }: { repo: RepoRef | undefined }) {
  const overview = useReleaseOverview()
  const navigate = useNavigate()
  const current = repo ? repoKey(repo) : undefined
  const options = (overview.data?.cards ?? []).map((card) => ({
    id: repoKey(card.repo),
    label: <span className="mono">{card.repo.path}</span>,
    text: card.repo.path,
  }))
  if (current && !options.some((option) => option.id === current) && repo)
    options.unshift({
      id: current,
      label: <span className="mono">{repo.path}</span>,
      text: repo.path,
    })
  return (
    <Select
      aria-label="Repository"
      placeholder="Pick a repository"
      className="w-72 max-w-full"
      options={options}
      value={current}
      onChange={(key) => void navigate({ to: '/releases/timeline', search: { repo: key } })}
    />
  )
}

/**
 * Releases › Timeline for the repository in `?repo=` (without one it opens the first repository of
 * the Overview, action first): a repository switch over the repositories with releases on, a
 * search field over the versions, Configure (to the flow setup, with `settings:write`) and the
 * timeline itself.
 */
export function ReleaseTimelinePage() {
  const search = useSearch({ strict: false })
  const router = useRouter()
  const repo = parseRepoKey(search.repo)
  const view = useReleaseRepo(repo)
  const overview = useReleaseOverview()
  const actions = useReleaseActions()
  const [query, setQuery] = useState('')
  const data = view.data
  const first = overview.data ? actionFirst(overview.data.cards)[0] : undefined
  if (!repo && first)
    return <Navigate to="/releases/timeline" search={{ repo: repoKey(first.repo) }} replace />

  return (
    <Page
      crumbs={[
        { label: 'Timeline', link: { to: '/releases/timeline' } },
        ...(repo ? [{ label: repo.path }] : []),
      ]}
      actions={<RepoSwitch repo={repo} />}
      {...(repo
        ? {
            search: {
              value: query,
              onChange: setQuery,
              'aria-label': 'Find a version',
              placeholder: 'Find a version or task key',
            },
          }
        : {})}
      {...(repo && data?.can.configure
        ? { configure: { link: { to: '/releases/setup', search: { repo: repoKey(repo) } } } }
        : {})}
      more={[
        {
          label: 'Read the forge again',
          icon: RefreshCw,
          isDisabled: actions.refresh.isPending,
          onAction: () =>
            actions.refresh.mutate(undefined, {
              onError: (error) => notify.error('Not refreshed', messageOf(error)),
            }),
        },
        ...(repo
          ? [
              {
                label: 'Open repository',
                icon: FolderGit2,
                href: router.buildLocation({ to: '/repos/$', params: { _splat: repoSplat(repo) } })
                  .href,
              },
            ]
          : []),
      ]}
    >
      {!repo ? (
        <EmptyState
          title="No repository"
          description={
            <>
              Pick one above or open it from the <Link to="/releases">Overview</Link>.
            </>
          }
        />
      ) : view.isPending ? (
        <Loading />
      ) : view.isError ? (
        <ErrorState error={view.error} />
      ) : data ? (
        <Body repo={repo} data={data} query={query} />
      ) : null}
    </Page>
  )
}
