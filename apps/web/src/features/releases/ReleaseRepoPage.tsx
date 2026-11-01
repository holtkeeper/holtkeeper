import type { ReleaseEvent, ReleaseRepoView, RepoRef } from '@holtkeeper/api'
import { useQueryClient } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { BadgeCheck, GitPullRequestArrow, History, Settings2, Undo2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { keys, useReleaseActions, useReleaseRepo, useSettingMutations } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { countLabel } from '../../lib/releases.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  LinkButton,
  Loading,
  Notice,
  Page,
  Panel,
  Tabs,
  TextField,
  notify,
} from '../../ui/index.ts'
import { RepoAvatar } from '../repos/RepoAvatar.tsx'
import { DeployPanel } from './DeployPanel.tsx'
import { StageChip } from './parts.tsx'
import { PlanWorkspace } from './PlanWorkspace.tsx'

const eventLabels: Record<ReleaseEvent['kind'], string> = {
  proposed: 'Candidate proposed',
  merged: 'Candidate merged',
  accepted: 'Changes accepted',
  versioned: 'Version created',
  'deploy-started': 'Deploy started',
  'deploy-succeeded': 'Deployed',
  'deploy-failed': 'Deploy failed',
}

function AcceptancePanel({ repo, view }: { repo: RepoRef; view: ReleaseRepoView }) {
  const actions = useReleaseActions()
  const [note, setNote] = useState('')
  const { acceptance: settings } = view.settings
  const accepted = view.row.acceptance
  const editable = view.can.run && !view.readOnly
  const manual = settings.signals.includes('manual')
  const how = [
    manual
      ? 'a person here, the CLI (holtkeeper release accept) or POST /api/releases/accept'
      : undefined,
    settings.signals.includes('label')
      ? `the label “${settings.label}” on the merged merge request`
      : undefined,
    settings.signals.includes('merge') ? 'merging the release candidate' : undefined,
  ].filter(Boolean)
  return (
    <Panel
      title="Acceptance"
      description={
        settings.required
          ? 'Required before the version is created'
          : 'Optional; recorded in the history'
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {accepted ? (
          <div className="flex items-start gap-2 text-success">
            <BadgeCheck className="mt-0.5 size-4 shrink-0" />
            <span>
              Accepted by <b>{accepted.by}</b> {formatRelative(accepted.at)} ({accepted.via})
              {accepted.note ? `: ${accepted.note}` : ''}
            </span>
          </div>
        ) : (
          <p className="text-muted">Not accepted yet. Accepted by {how.join(', or ')}.</p>
        )}
        {editable && manual ? (
          accepted ? (
            <Button
              size="sm"
              variant="tertiary"
              onPress={() =>
                actions.withdraw.mutate(repo, {
                  onError: (error) => notify.error('Not withdrawn', messageOf(error)),
                })
              }
              isPending={actions.withdraw.isPending}
            >
              <Undo2 className="size-3.5" />
              Withdraw
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <TextField
                aria-label="Note"
                placeholder="Note, e.g. what was checked"
                value={note}
                onChange={setNote}
              />
              <Button
                size="sm"
                variant="secondary"
                isPending={actions.accept.isPending}
                onPress={() =>
                  actions.accept.mutate(
                    { repo: repoKey(repo), ...(note.trim() ? { note: note.trim() } : {}) },
                    {
                      onSuccess: (result) => {
                        setNote('')
                        notify.success(result.detail)
                      },
                      onError: (error) => notify.error('Not accepted', messageOf(error)),
                    },
                  )
                }
              >
                <BadgeCheck className="size-3.5" />
                Accept for release
              </Button>
            </div>
          )
        ) : null}
      </div>
    </Panel>
  )
}

function HistoryPanel({ view }: { view: ReleaseRepoView }) {
  if (!view.history.length)
    return (
      <Panel>
        <EmptyState icon={<History />} title="No release events yet" />
      </Panel>
    )
  return (
    <Panel title="History">
      <ol className="flex flex-col divide-y divide-separator text-sm">
        {view.history.map((event) => (
          <li
            key={`${event.at}-${event.kind}-${event.environment ?? ''}`}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
          >
            <span className={`font-medium ${event.kind === 'deploy-failed' ? 'text-danger' : ''}`}>
              {eventLabels[event.kind]}
            </span>
            {event.tag ? <span className="font-mono">{event.tag}</span> : null}
            {event.environment ? <span>→ {event.environment}</span> : null}
            {event.detail ? <span className="text-muted">{event.detail}</span> : null}
            {event.url ? (
              <a href={event.url} target="_blank" rel="noreferrer" className="hover:underline">
                open
              </a>
            ) : null}
            <span className="ml-auto text-xs text-muted" title={formatDateTime(event.at)}>
              {event.actor} · {formatRelative(event.at)}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  )
}

function DetectionNotice({ repo, view }: { repo: RepoRef; view: ReleaseRepoView }) {
  const { put } = useSettingMutations()
  const client = useQueryClient()
  const detection = view.detection
  if (!detection) return null
  return (
    <Notice tone="accent" title={`Looks like the “${detection.preset}” flow`}>
      <div className="flex flex-col gap-2">
        <span>
          This repository follows the release flow set for everything. What it seems to do:{' '}
          {detection.reasons.join('; ')}.
        </span>
        {view.can.configure ? (
          <div>
            <Button
              size="sm"
              variant="secondary"
              isPending={put.isPending}
              onPress={() =>
                put.mutate(
                  { key: 'releases', scope: { repos: [repo.path] }, value: detection.settings },
                  {
                    onSuccess: () => {
                      notify.success('Release flow saved for this repository')
                      void client.invalidateQueries({ queryKey: keys.releases })
                    },
                    onError: (error) => notify.error('Not saved', messageOf(error)),
                  },
                )
              }
            >
              Use it for this repository
            </Button>
          </div>
        ) : null}
      </div>
    </Notice>
  )
}

function flowSummary(view: ReleaseRepoView) {
  const { flow, version } = view.settings
  const target = view.row.target ?? flow.target ?? 'default branch'
  const tags = version.tagFormat.replace(
    '{version}',
    version.scheme === 'semver' ? '1.2.3' : '2026.11.0',
  )
  if (flow.mode === 'external') return 'Released by another tool'
  return flow.mode === 'trunk'
    ? `Trunk: versions tagged on ${target} as ${tags}`
    : `${flow.source} → ${target} through a merge request, tagged as ${tags}`
}

/** One repository's release workspace: the next version, the candidate, deploys and history. */
export function ReleaseRepoPage() {
  const search = useSearch({ strict: false })
  const repo = parseRepoKey(typeof search.repo === 'string' ? search.repo : undefined)
  const view = useReleaseRepo(repo)
  const [tab, setTab] = useState<string>()

  if (!repo)
    return (
      <EmptyState title="No repository" description="Open a repository from the release board." />
    )
  const data = view.data
  const tabs = data
    ? [
        ...(data.version
          ? [
              {
                id: 'version',
                label: `Version · ${countLabel(data.row.unreleased, data.row.unreleasedCapped)}`,
                content: (
                  <PlanWorkspace
                    repo={repo}
                    view={data}
                    plan={data.version}
                    step="version"
                    extra={<AcceptancePanel repo={repo} view={data} />}
                  />
                ),
              },
            ]
          : []),
        ...(data.settings.flow.mode === 'merge-request'
          ? [
              {
                id: 'propose',
                label: `Candidate · ${countLabel(data.row.ahead, data.row.aheadCapped)}`,
                content: data.proposal ? (
                  <PlanWorkspace repo={repo} view={data} plan={data.proposal} step="propose" />
                ) : (
                  <Panel>
                    <EmptyState
                      icon={<GitPullRequestArrow />}
                      title={`${data.settings.flow.source} has nothing new`}
                      description={`Every change on ${data.settings.flow.source} is already on ${data.row.target}.`}
                    />
                  </Panel>
                ),
              },
            ]
          : []),
        { id: 'deploy', label: 'Deploy', content: <DeployPanel repo={repo} view={data} /> },
        { id: 'history', label: 'History', content: <HistoryPanel view={data} /> },
      ]
    : []

  return (
    <Page
      title={repo.path}
      eyebrow="Release"
      media={<RepoAvatar repo={repo} size="lg" />}
      description={data ? flowSummary(data) : undefined}
      actions={
        <div className="flex items-center gap-2">
          {data ? <StageChip stage={data.row.stage} /> : null}
          <LinkButton to="/settings" search={{ repo: repoKey(repo) }} variant="secondary" size="sm">
            <Settings2 className="size-3.5" />
            Release flow
          </LinkButton>
        </div>
      }
    >
      {view.isPending ? (
        <Loading label="Reading the repository from the forge" />
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
          <DetectionNotice repo={repo} view={data} />
          {data.settings.flow.mode === 'external' ? (
            <Notice title="Released by another tool">
              The release flow marks this repository as released elsewhere (changesets,
              release-please, …). Its versions and deploys still show here.
            </Notice>
          ) : null}
          <Tabs
            aria-label="Release steps"
            items={tabs}
            selected={tab && tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id}
            onSelect={setTab}
          />
        </>
      ) : null}
    </Page>
  )
}
