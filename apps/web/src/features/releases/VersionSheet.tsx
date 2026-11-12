import type {
  PersonView,
  ReleaseProvenance,
  ReleaseRepoView,
  ReleaseVersionDetailView,
  ReleaseVersionView,
  RepoRef,
} from '@holtkeeper/api'
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { useReleaseVersion } from '../../api/queries.ts'
import { formatDate, formatDateTime, shortSha } from '../../lib/format.ts'
import {
  acceptedVia,
  liveOn,
  versionEnvironments,
  versionNotesText,
  versionTicks,
} from '../../lib/release-timeline.ts'
import { actorName, channelLabel, countLabel } from '../../lib/releases.ts'
import {
  ErrorState,
  KeyValue,
  type KeyValueRow,
  Markdown,
  Placeholder,
  SideSheet,
  Tag,
} from '../../ui/index.ts'
import { VersionDeploys } from './DeployStrip.tsx'
import { BumpTag, TaskList } from './parts.tsx'
import { deployProgress } from './version-progress.ts'

type Section = 'deploys' | 'changelog' | 'tasks' | 'notes'

const sections: readonly Section[] = ['deploys', 'changelog', 'tasks', 'notes']

const who = (
  people: Readonly<Record<string, PersonView>>,
  step: { actor: string; actorName?: string; channel?: string; at: string },
) => (
  <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
    <span>{actorName(people, step.actor, step.actorName)}</span>
    <span className="text-xs text-muted">
      {[channelLabel(step.channel), formatDateTime(step.at)].filter(Boolean).join(' · ')}
    </span>
  </span>
)

function provenanceRows(
  provenance: ReleaseProvenance,
  people: Readonly<Record<string, PersonView>>,
): KeyValueRow[] {
  const { accepted, versioned } = provenance
  return [
    { label: 'Accepted by', value: accepted ? who(people, accepted) : 'Nobody recorded' },
    { label: 'Accepted', value: accepted?.via ? acceptedVia(accepted.via) : undefined },
    { label: 'Note', value: accepted?.note },
    {
      label: 'Accepted commit',
      value: accepted?.sha ? <span className="mono">{shortSha(accepted.sha)}</span> : undefined,
    },
    { label: 'Tagged by', value: versioned ? who(people, versioned) : undefined },
    {
      label: 'Checks',
      value: versioned ? (
        versioned.force ? (
          <Tag tone="warning">Failing checks overridden</Tag>
        ) : (
          'No failing checks'
        )
      ) : undefined,
    },
    { label: 'Notes', value: versioned?.notes ? versionNotesText(versioned.notes) : undefined },
    {
      label: 'CHANGELOG.md',
      value: versioned ? (
        versioned.changelogSha ? (
          <>
            Prepended <span className="mono text-muted">{shortSha(versioned.changelogSha)}</span>
          </>
        ) : (
          'Not written'
        )
      ) : undefined,
    },
    {
      label: 'Release',
      value: versioned?.url ? (
        <a href={versioned.url} target="_blank" rel="noreferrer" className="hover:underline">
          Release page
        </a>
      ) : undefined,
    },
  ]
}

function DeploysSection({
  repo,
  view,
  data,
}: {
  repo: RepoRef
  view: ReleaseRepoView
  data: ReleaseVersionDetailView
}) {
  const people = { ...view.people, ...data.people }
  return (
    <div className="flex flex-col gap-5">
      <VersionDeploys
        repo={repo}
        view={view}
        tag={data.tag}
        initial={data.deploy}
        people={people}
      />
      <section className="flex flex-col gap-2">
        <h3 className="text-xs text-dim">Version</h3>
        <KeyValue
          rows={[
            {
              label: 'Tag',
              value: (
                <>
                  <span className="mono">{data.tag}</span>
                  {view.row.target ? (
                    <span className="text-xs text-muted">on {view.row.target}</span>
                  ) : null}
                </>
              ),
            },
            { label: 'Bump', value: <BumpTag bump={data.bump} /> },
            {
              label: 'Since',
              value: (
                <>
                  {data.previous ? <span className="mono">{data.previous}</span> : 'first version'}
                  <span className="text-xs text-muted">
                    {countLabel(data.commitCount, data.capped)}
                  </span>
                </>
              ),
            },
            { label: 'Commit', value: <span className="mono">{shortSha(data.sha)}</span> },
            { label: 'Released', value: data.date ? formatDate(data.date) : undefined },
          ]}
        />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs text-dim">How it was cut</h3>
        {data.provenance ? (
          <KeyValue rows={provenanceRows(data.provenance, people)} />
        ) : (
          <p className="text-sm text-muted">
            Holtkeeper did not create this version; its tag was made elsewhere.
          </p>
        )}
      </section>
    </div>
  )
}

function NotesSection({ data }: { data: ReleaseVersionDetailView }) {
  const notes = data.provenance?.versioned?.notes
  if (!notes)
    return (
      <p className="text-sm text-muted">
        {data.provenance?.versioned
          ? 'No notes were recorded with this version.'
          : 'Holtkeeper did not create this version, so it holds no notes of it.'}
      </p>
    )
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">{versionNotesText(notes)}</p>
      {notes.markdown ? (
        <Markdown text={notes.markdown} />
      ) : (
        <p className="text-sm text-muted">The version was created without written notes.</p>
      )}
    </div>
  )
}

/**
 * One version in the side sheet: its deploys as the progress bar, tabs for deploys (each attempt
 * with who started it and why, the version facts and how it was cut: who accepted it, who tagged
 * it, overrides, the notes and the `CHANGELOG.md` commit), changelog, tasks and the written
 * notes with their source. J and K step
 * through the versions of the table behind it.
 */
export function VersionSheet({
  repo,
  view,
  version,
  onClose,
  ...position
}: {
  repo: RepoRef
  view: ReleaseRepoView
  version: ReleaseVersionView
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const detail = useReleaseVersion(repo, version.tag)
  const [section, setSection] = useState<Section>('deploys')
  const environments = versionEnvironments(
    view.settings.deploy.environments.map((env) => env.name),
    [version],
  )
  const progress = deployProgress(versionTicks(version, environments))
  const live = liveOn(view.row.environments, version.tag)
  const compareUrl = detail.data?.compareUrl
  const data = detail.data
  return (
    <SideSheet
      open
      onClose={onClose}
      id={version.tag}
      copyId={version.tag}
      title={repo.path}
      {...position}
      {...(progress
        ? {
            progress: {
              segments: progress.segments,
              label: live.length
                ? `Live on ${live.join(', ')} · ${progress.label}`
                : progress.label,
            },
          }
        : {})}
      {...(compareUrl
        ? {
            quietActions: [
              {
                label: version.previous ? `Compare ${version.previous}` : 'Compare',
                icon: ExternalLink,
                onPress: () => window.open(compareUrl, '_blank', 'noreferrer'),
              },
            ] as const,
          }
        : {})}
      tabs={{
        items: [
          { id: 'deploys', label: 'Deploys' },
          {
            id: 'changelog',
            label: 'Changelog',
            ...(data ? { badge: data.entries.filter((entry) => entry.included).length } : {}),
          },
          { id: 'tasks', label: 'Tasks', badge: version.tickets.length },
          { id: 'notes', label: 'Notes' },
        ],
        selected: section,
        onSelect: (id) => setSection(sections.find((candidate) => candidate === id) ?? 'deploys'),
        'aria-label': 'Version details',
      }}
    >
      {detail.isPending ? (
        <Placeholder className="h-24" />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : section === 'tasks' ? (
        <TaskList tasks={detail.data.tasks} />
      ) : section === 'notes' ? (
        <NotesSection data={detail.data} />
      ) : section === 'changelog' ? (
        detail.data.changelog.trim() ? (
          <Markdown text={detail.data.changelog} />
        ) : (
          <p className="text-sm text-muted">No entries.</p>
        )
      ) : (
        <DeploysSection repo={repo} view={view} data={detail.data} />
      )}
    </SideSheet>
  )
}
