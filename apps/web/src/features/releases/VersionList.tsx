import type { ReleaseRepoView, ReleaseVersionView, RepoRef } from '@holtkeeper/api'
import { ChevronRight, ExternalLink, History, PanelRight } from 'lucide-react'
import { useState } from 'react'

import { useReleaseTimeline, useReleaseVersion } from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDate, formatRelative, plural } from '../../lib/format.ts'
import { countLabel, versionTicks } from '../../lib/releases.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  LoadMore,
  Markdown,
  Placeholder,
  SideSheet,
  TickStrip,
  Tooltip,
} from '../../ui/index.ts'
import { DeployStrip } from './DeployStrip.tsx'
import { BumpTag, TaskList } from './parts.tsx'

function VersionBody({
  repo,
  view,
  tag,
  full,
}: {
  repo: RepoRef
  view: ReleaseRepoView
  tag: string
  full?: boolean
}) {
  const detail = useReleaseVersion(repo, tag)
  if (detail.isPending) return <Placeholder className="h-24" />
  if (detail.isError) return <ErrorState error={detail.error} />
  const data = detail.data
  return (
    <div className="flex flex-col gap-4">
      {full ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <BumpTag bump={data.bump} />
          <span>{countLabel(data.commitCount, data.capped)}</span>
          {data.previous ? (
            <span>
              since <span className="mono">{data.previous}</span>
            </span>
          ) : null}
          {data.date ? <span>{formatDate(data.date)}</span> : null}
          <span className="mono">{data.sha.slice(0, 8)}</span>
          {data.compareUrl ? (
            <a
              href={data.compareUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
            >
              Compare <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
      {full && data.deploy ? (
        <DeployStrip repo={repo} view={view} tag={data.tag} initial={data.deploy} />
      ) : null}
      <section className="flex flex-col gap-2">
        <h4 className="text-xs text-dim">Tasks · {data.tasks.length}</h4>
        <TaskList tasks={data.tasks} />
      </section>
      <section className="flex flex-col gap-2">
        <h4 className="text-xs text-dim">Changelog</h4>
        {data.changelog.trim() ? (
          <Markdown text={data.changelog} />
        ) : (
          <p className="text-sm text-muted">No entries.</p>
        )}
      </section>
    </div>
  )
}

function VersionRow({
  repo,
  view,
  version,
  onOpen,
}: {
  repo: RepoRef
  view: ReleaseRepoView
  version: ReleaseVersionView
  onOpen: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const environments = view.settings.deploy.environments.map((env) => env.name)
  const ticks = versionTicks(version.deploys, environments)
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${version.tag}`}
          onClick={() => setExpanded((on) => !on)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronRight
            className={`size-3.5 shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <span className="mono w-32 shrink-0 truncate text-[13px] font-semibold">
            {version.tag}
          </span>
          <BumpTag bump={version.bump} />
          <span className="truncate text-xs text-muted">
            {countLabel(version.commitCount, version.capped)}
            {version.tickets.length ? ` · ${plural(version.tickets.length, 'task')}` : ''}
          </span>
        </button>
        {ticks.length ? (
          <TickStrip
            ticks={ticks}
            aria-label={ticks.map((tick) => tick.label).join(', ')}
            className="hidden w-24 sm:flex"
          />
        ) : null}
        <span className="hidden w-24 shrink-0 text-right text-xs text-dim sm:block">
          {version.date ? formatRelative(version.date) : ''}
        </span>
        <Tooltip content="Open in the side sheet">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={`Open ${version.tag}`}
            onPress={onOpen}
          >
            <PanelRight className="size-3.5" />
          </Button>
        </Tooltip>
      </div>
      {expanded ? (
        <div className="px-3 pb-3 pl-9">
          <VersionBody repo={repo} view={view} tag={version.tag} />
        </div>
      ) : null}
    </li>
  )
}

/**
 * Past versions, newest first, loaded a page at a time as the list scrolls. A row expands to its
 * tasks and changelog; opening one shows it in the side sheet with its deploys, and J/K step
 * through the loaded versions.
 */
export function VersionList({ repo, view }: { repo: RepoRef; view: ReleaseRepoView }) {
  const timeline = useReleaseTimeline(repo)
  const [openTag, setOpenTag] = useState<string>()
  const versions = timeline.data?.pages.flatMap((page) => page.versions) ?? []
  const total = timeline.data?.pages[0]?.total ?? 0
  const tags = versions.map((version) => version.tag)
  const step = neighbours(tags, openTag)

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs text-dim">
        Versions{total ? <span className="tabular"> · {total}</span> : null}
      </h2>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {timeline.isPending ? (
          <div className="flex flex-col gap-1 p-3">
            {[0, 1, 2].map((i) => (
              <Placeholder key={i} className="h-8" />
            ))}
          </div>
        ) : timeline.isError ? (
          <ErrorState error={timeline.error} />
        ) : versions.length === 0 ? (
          <EmptyState icon={<History />} title="No versions yet" />
        ) : (
          <ul>
            {versions.map((version) => (
              <VersionRow
                key={version.tag}
                repo={repo}
                view={view}
                version={version}
                onOpen={() => setOpenTag(version.tag)}
              />
            ))}
          </ul>
        )}
      </div>
      {timeline.hasNextPage ? (
        <LoadMore
          onLoad={() => void timeline.fetchNextPage()}
          isPending={timeline.isFetchingNextPage}
          className="self-center"
        >
          Older versions
        </LoadMore>
      ) : null}
      <SideSheet
        open={openTag !== undefined}
        onClose={() => setOpenTag(undefined)}
        id={openTag}
        title={repo.path}
        {...(step.index >= 0 ? { index: step.index, total } : {})}
        {...(step.previous ? { onPrevious: () => setOpenTag(step.previous) } : {})}
        {...(step.next ? { onNext: () => setOpenTag(step.next) } : {})}
      >
        {openTag ? <VersionBody key={openTag} repo={repo} view={view} tag={openTag} full /> : null}
      </SideSheet>
    </section>
  )
}
