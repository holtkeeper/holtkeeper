import type { ReleaseRepoView, RepoRef } from '@holtkeeper/api'
import { History, PanelRight } from 'lucide-react'
import { useState } from 'react'

import { useReleaseTimeline } from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDate, shortSha } from '../../lib/format.ts'
import {
  changesText,
  filterVersions,
  versionDeployCell,
  versionEnvironments,
} from '../../lib/release-timeline.ts'
import {
  Button,
  Count,
  Dot,
  EmptyState,
  ErrorState,
  FilterButton,
  Kbd,
  ListFooter,
  LoadMore,
  Placeholder,
  Table,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { BumpTag } from './parts.tsx'
import { VersionSheet } from './VersionSheet.tsx'

const bumpOptions = [
  { id: 'major', label: 'Major' },
  { id: 'minor', label: 'Minor' },
  { id: 'patch', label: 'Patch' },
]

/**
 * Past versions, newest first, a page at a time: a table with the bump, the changes, one column
 * per environment with where the version stands there, the release date and commit. `query`
 * (the page's search field) and the Bump and Environment filters narrow the loaded versions. A
 * row opens the version sheet; J and K step through the shown rows.
 */
export function VersionList({
  repo,
  view,
  query = '',
}: {
  repo: RepoRef
  view: ReleaseRepoView
  query?: string
}) {
  const timeline = useReleaseTimeline(repo)
  const [openTag, setOpenTag] = useState<string>()
  const [bumps, setBumps] = useState<string[]>([])
  const [deployedTo, setDeployedTo] = useState<string[]>([])
  const loaded = timeline.data?.pages.flatMap((page) => page.versions) ?? []
  const total = timeline.data?.pages[0]?.total ?? 0
  const environments = versionEnvironments(
    view.settings.deploy.environments.map((env) => env.name),
    loaded,
  )
  const versions = filterVersions(loaded, { query, bumps, environments: deployedTo })
  const filtered = versions.length !== loaded.length
  const step = neighbours(
    versions.map((version) => version.tag),
    openTag,
  )
  const opened = loaded.find((version) => version.tag === openTag)

  return (
    <section aria-label="Versions" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">Versions</h2>
        {total ? <Count>{total}</Count> : null}
        <span className="flex-1" />
        <FilterButton
          label="Bump"
          all="All"
          options={bumpOptions}
          value={bumps}
          onChange={setBumps}
        />
        {environments.length ? (
          <FilterButton
            label="Deployed to"
            all="Any"
            options={environments.map((name) => ({ id: name, label: name }))}
            value={deployedTo}
            onChange={setDeployedTo}
          />
        ) : null}
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {timeline.isPending ? (
          <div className="flex flex-col gap-1 p-3">
            {[0, 1, 2].map((i) => (
              <Placeholder key={i} className="h-8" />
            ))}
          </div>
        ) : timeline.isError ? (
          <ErrorState error={timeline.error} />
        ) : loaded.length === 0 ? (
          <EmptyState icon={<History />} title="No versions yet" />
        ) : versions.length === 0 ? (
          <EmptyState icon={<History />} title="No loaded version matches" />
        ) : (
          <Table label={`Versions of ${repo.path}`}>
            <thead>
              <tr>
                <Th>Version</Th>
                <Th>Bump</Th>
                <Th>Changes</Th>
                {environments.map((name) => (
                  <Th key={name}>
                    <span className="mono">{name}</span>
                  </Th>
                ))}
                <Th>Released</Th>
                <Th>Commit</Th>
                <Th>
                  <span className="sr-only">Open</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <Tr
                  key={version.tag}
                  selected={version.tag === openTag}
                  onClick={() => setOpenTag(version.tag)}
                >
                  <Td>
                    <span className="mono text-[13px] font-semibold">{version.tag}</span>
                  </Td>
                  <Td>
                    <BumpTag bump={version.bump} />
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-muted">{changesText(version)}</Td>
                  {environments.map((name) => {
                    const cell = versionDeployCell(version, name)
                    return (
                      <Td key={name} className="whitespace-nowrap text-xs">
                        <span className="inline-flex items-center gap-1.5">
                          <Dot tone={cell.tone} />
                          <span className={cell.tone === 'none' ? 'text-dim' : ''}>
                            {cell.label}
                          </span>
                        </span>
                      </Td>
                    )
                  })}
                  <Td className="whitespace-nowrap text-xs text-muted">
                    {version.date ? formatDate(version.date) : '—'}
                  </Td>
                  <Td>
                    <span className="mono text-xs text-muted">{shortSha(version.sha)}</span>
                  </Td>
                  <Td align="right">
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      aria-label={`Open ${version.tag} in the side sheet`}
                      onPress={() => setOpenTag(version.tag)}
                    >
                      <PanelRight className="size-3.5" />
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {loaded.length ? (
          <ListFooter
            className="border-t border-line"
            shown={loaded.length}
            total={total}
            noun="versions"
            {...(filtered ? { caption: `· ${versions.length} match` } : {})}
            more={
              timeline.hasNextPage ? (
                <LoadMore
                  onLoad={() => void timeline.fetchNextPage()}
                  isPending={timeline.isFetchingNextPage}
                >
                  Older versions
                </LoadMore>
              ) : undefined
            }
            hints={
              <>
                Step <Kbd>J</Kbd>
                <Kbd>K</Kbd> · open <Kbd>↵</Kbd>
              </>
            }
          />
        ) : null}
      </div>
      {opened ? (
        <VersionSheet
          key={opened.tag}
          repo={repo}
          view={view}
          version={opened}
          onClose={() => setOpenTag(undefined)}
          {...(step.index >= 0 ? { index: step.index, total: versions.length } : {})}
          {...(step.previous ? { onPrevious: () => setOpenTag(step.previous) } : {})}
          {...(step.next ? { onNext: () => setOpenTag(step.next) } : {})}
        />
      ) : null}
    </section>
  )
}
