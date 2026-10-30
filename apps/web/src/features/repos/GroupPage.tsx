import type { ConfigEntryView } from '@holtkeeper/api'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useGroups, usePutGroup, useRepos } from '../../api/queries.ts'
import { fleetView } from '../../lib/analyses.ts'
import { formatRelative } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Notice,
  Page,
  Panel,
  Placeholder,
  TagInput,
  Tabs,
  notify,
} from '../../ui/index.ts'
import { AnalysisRecords } from '../analyses/AnalysesPage.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { ScopedKnowledge } from '../knowledge/ScopedKnowledge.tsx'
import { ScopedSettings } from '../settings/ScopedSettings.tsx'
import { useSession } from '../shell/session.ts'
import { GroupListing } from './GroupListing.tsx'

/** One group: its repositories and patterns, fleet drift records, settings and knowledge. */
export function GroupPage() {
  const { can } = useSession()
  const { groupId } = useParams({ from: '/app/repos/groups/$groupId' })
  const search = useSearch({ from: '/app/repos/groups/$groupId' })
  const navigate = useNavigate({ from: '/repos/groups/$groupId' })
  const repos = useRepos()
  const config = useGroups(can('settings:read'))
  const definition = config.data?.entries.find((entry) => entry.id === groupId)
  const members = (repos.data?.repos ?? []).filter((r) => r.groups.includes(groupId))
  const allGroups = [...new Set((repos.data?.repos ?? []).flatMap((r) => r.groups))].toSorted()
  const focus = { kind: 'group' as const, group: groupId }
  const forge = definition?.data.forge ?? members[0]?.repo.forge

  const tabs = [
    {
      id: 'repos',
      label: (
        <span className="flex items-center gap-1.5">
          Repositories
          {members.length ? <span className="text-xs text-muted">{members.length}</span> : null}
        </span>
      ),
      content: (
        <div className="flex flex-col gap-4">
          {can('settings:read') ? (
            config.isPending ? (
              <Placeholder className="h-32" />
            ) : config.isError ? (
              <ErrorState error={config.error} />
            ) : definition ? (
              <GroupDefinition key={definition.version ?? 0} entry={definition} />
            ) : (
              <Notice tone="warning" title="Not in the config">
                No group {groupId} is configured; entries naming it match nothing.
              </Notice>
            )
          ) : null}
          {can('settings:read') && definition ? <GroupListing group={groupId} /> : null}
          <Panel title="Known repositories" contentClassName="p-2">
            {members.length === 0 ? (
              <EmptyState
                icon={<FolderGit2 />}
                title="No known repositories yet"
                description="Repositories show up once audited or added by exact path."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-separator">
                {members.map(({ repo, latestAudit }) => (
                  <li key={repoKey(repo)} className="flex items-center justify-between gap-3 py-2">
                    <Link
                      to="/repos/view"
                      search={{ repo: repoKey(repo) }}
                      className="font-medium hover:underline"
                    >
                      {repo.path}
                    </Link>
                    <span className="text-xs text-muted">
                      {latestAudit
                        ? `audited ${formatRelative(latestAudit.finishedAt)}`
                        : 'never audited'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      ),
    },
    ...(can('analyses:read') && forge
      ? [
          {
            id: 'fleet',
            label: 'Fleet',
            content: (
              <AnalysisRecords page={fleetView} repo={{ forge, path: groupId }} group={groupId} />
            ),
          },
        ]
      : []),
    ...(can('settings:read')
      ? [
          {
            id: 'settings',
            label: 'Settings',
            content: <ScopedSettings focus={focus} groups={allGroups} />,
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
  ]
  const selected = tabs.some((t) => t.id === search.tab) ? search.tab : 'repos'

  return (
    <Page
      eyebrow={
        <Link to="/repos" className="hover:underline">
          Repositories
        </Link>
      }
      title={`Group ${groupId}`}
      description={
        definition ? (
          <span className="flex items-center gap-1.5">
            {definition.data.forge}
            <Chip>{definition.provenance === 'file' ? 'config file' : 'panel'}</Chip>
          </span>
        ) : undefined
      }
      actions={<RunJobButton group={groupId} />}
    >
      <Tabs
        aria-label="Group sections"
        selected={selected ?? 'repos'}
        onSelect={(tab) =>
          void navigate({ search: (previous) => ({ ...previous, tab }), replace: true })
        }
        items={tabs}
      />
    </Page>
  )
}

/** The group's include and exclude patterns, editable with global `settings:write`. */
function GroupDefinition({ entry }: { entry: ConfigEntryView<'group'> }) {
  const { can } = useSession()
  const put = usePutGroup()
  const [include, setInclude] = useState<string[]>(entry.data.include)
  const [exclude, setExclude] = useState<string[]>(entry.data.exclude)
  const writable = can('settings:write')
  const changed =
    include.join('\n') !== entry.data.include.join('\n') ||
    exclude.join('\n') !== entry.data.exclude.join('\n')

  return (
    <Panel
      title="Membership"
      description="Path globs on the forge; exact paths list the repository even before its first audit."
      actions={
        writable && changed ? (
          <Button
            variant="primary"
            size="sm"
            isDisabled={include.length === 0}
            isPending={put.isPending}
            onPress={() =>
              put.mutate(
                { id: entry.id, data: { forge: entry.data.forge, include, exclude } },
                {
                  onSuccess: () => notify.success('Group saved', entry.id),
                  onError: (error) => notify.error('Not saved', messageOf(error)),
                },
              )
            }
          >
            Save
          </Button>
        ) : null
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        {writable ? (
          <>
            <TagInput
              label="Include"
              values={include}
              onChange={setInclude}
              placeholder="team/* or team/app"
            />
            <TagInput
              label="Exclude"
              values={exclude}
              onChange={setExclude}
              placeholder="team/legacy-*"
            />
          </>
        ) : (
          <>
            <PatternList label="Include" patterns={include} />
            <PatternList label="Exclude" patterns={exclude} />
          </>
        )}
      </div>
      {writable && entry.provenance === 'file' && changed ? (
        <p className="mt-2 text-xs text-muted">
          Saving makes a panel copy that replaces the group from the config file.
        </p>
      ) : null}
    </Panel>
  )
}

function PatternList({ label, patterns }: { label: string; patterns: readonly string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {patterns.length ? (
        <div className="flex flex-wrap gap-1">
          {patterns.map((pattern) => (
            <Chip key={pattern}>
              <span className="font-mono text-[11px]">{pattern}</span>
            </Chip>
          ))}
        </div>
      ) : (
        <span className="text-xs text-muted">none</span>
      )}
    </div>
  )
}
