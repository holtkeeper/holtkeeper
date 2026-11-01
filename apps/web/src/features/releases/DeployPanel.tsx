import type { EnvironmentState, ReleaseRepoView, RepoRef } from '@holtkeeper/api'
import { ExternalLink, Play, RotateCcw, Rocket } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useReleaseActions, useReleaseDeploy } from '../../api/queries.ts'
import { formatDuration, formatRelative } from '../../lib/format.ts'
import { deployLabels, deployTones } from '../../lib/releases.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  ErrorState,
  Loading,
  Panel,
  Select,
  notify,
} from '../../ui/index.ts'
import { PipelineDot } from './parts.tsx'

type Intent = { environment: EnvironmentState; kind: 'deploy' | 'retry' | 'redeploy' }

function EnvironmentCard({
  environment,
  editable,
  onRun,
}: {
  environment: EnvironmentState
  editable: boolean
  onRun: (kind: Intent['kind']) => void
}) {
  const { status } = environment
  const kind: Intent['kind'] | undefined =
    status === 'ready' || status === 'waiting'
      ? 'deploy'
      : status === 'failed' || status === 'canceled'
        ? 'retry'
        : status === 'success'
          ? 'redeploy'
          : undefined
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-semibold">{environment.name}</div>
          <div className="text-xs text-muted">
            {environment.job ?? environment.name}
            {environment.after ? ` · after ${environment.after}` : ''}
            {environment.auto ? ' · automatic' : ''}
          </div>
        </div>
        <Chip tone={deployTones[status]}>{deployLabels[status]}</Chip>
      </div>
      {environment.current ? (
        <div className="text-xs text-muted">
          Now on {environment.name}: <span className="font-mono">{environment.current.ref}</span> (
          {environment.current.status}
          {environment.current.at ? `, ${formatRelative(environment.current.at)}` : ''})
        </div>
      ) : null}
      {environment.attempts.length ? (
        <ol className="flex flex-col gap-1 text-xs">
          {environment.attempts.slice(0, 5).map((attempt, index) => (
            <li key={attempt.jobId} className="flex items-center gap-2">
              <span className={index === 0 ? 'font-medium' : 'text-muted'}>
                #{environment.attempts.length - index}
              </span>
              <Chip
                tone={
                  attempt.status === 'success'
                    ? 'success'
                    : attempt.status === 'failed'
                      ? 'danger'
                      : 'default'
                }
              >
                {attempt.status}
              </Chip>
              {attempt.startedAt ? (
                <span className="text-muted">{formatRelative(attempt.startedAt)}</span>
              ) : null}
              {attempt.durationSeconds !== undefined ? (
                <span className="text-muted">{formatDuration(attempt.durationSeconds * 1000)}</span>
              ) : null}
              <a
                href={attempt.webUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-muted hover:text-foreground"
                aria-label="Open job"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted">
          {status === 'no-pipeline'
            ? 'The tag has no pipeline yet.'
            : status === 'missing'
              ? 'The tag pipeline has no job for it.'
              : 'Not run yet.'}
        </p>
      )}
      {editable && kind ? (
        <Button
          size="sm"
          variant={kind === 'deploy' ? 'primary' : kind === 'retry' ? 'danger-soft' : 'secondary'}
          onPress={() => onRun(kind)}
        >
          {kind === 'deploy' ? <Play className="size-3.5" /> : <RotateCcw className="size-3.5" />}
          {kind === 'deploy' ? 'Deploy' : kind === 'retry' ? 'Retry' : 'Deploy again'}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Deploy state of a version per environment, with every attempt of its job (failed ones too),
 * and buttons that start, retry or rerun the jobs. Older versions can be picked to roll back.
 */
export function DeployPanel({ repo, view }: { repo: RepoRef; view: ReleaseRepoView }) {
  const [tag, setTag] = useState(view.deploy?.tag ?? view.versions[0]?.tag)
  const deploy = useReleaseDeploy(repo, tag, view.deploy)
  const actions = useReleaseActions()
  const [intent, setIntent] = useState<Intent>()
  const [force, setForce] = useState(false)
  const editable = view.can.run && !view.readOnly

  if (!view.settings.deploy.environments.length)
    return (
      <Panel>
        <EmptyState
          icon={<Rocket />}
          title="No environments"
          description="Add environments to the Release flow setting: each names the manual pipeline job of a tag that deploys it."
        />
      </Panel>
    )
  if (!tag)
    return (
      <Panel>
        <EmptyState
          icon={<Rocket />}
          title="No versions yet"
          description="Create a version first."
        />
      </Panel>
    )

  const start = (current: Intent) => {
    actions.deploy.mutate(
      {
        repo: repoKey(repo),
        tag,
        environment: current.environment.name,
        ...(current.kind === 'redeploy' ? { redeploy: true } : {}),
        ...(force ? { force: true } : {}),
      },
      {
        onSuccess: (result) => {
          setIntent(undefined)
          setForce(false)
          notify.success(
            result.dryRun ? `Dry run: ${result.detail}` : result.detail,
            'Holtkeeper follows the job and reports how it ends.',
          )
          void deploy.refetch()
        },
        onError: (error) => notify.error('Not started', messageOf(error)),
      },
    )
  }

  const request = (environment: EnvironmentState, kind: Intent['kind']) => {
    const next = { environment, kind }
    if (environment.confirm || environment.status === 'waiting' || kind === 'redeploy')
      setIntent(next)
    else start(next)
  }

  return (
    <Panel
      title="Deploy"
      description="Manual jobs of the version's tag pipeline, one per environment"
      actions={
        <div className="flex items-center gap-2">
          <PipelineDot label={tag} pipeline={deploy.data?.pipeline} />
          <Select
            aria-label="Version"
            className="w-44"
            options={view.versions.map((version) => ({ id: version.tag, label: version.tag }))}
            value={tag}
            onChange={setTag}
          />
        </div>
      }
    >
      {deploy.isPending ? (
        <Loading />
      ) : deploy.isError ? (
        <ErrorState error={deploy.error} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {deploy.data.environments.map((environment) => (
            <EnvironmentCard
              key={environment.name}
              environment={environment}
              editable={editable}
              onRun={(kind) => request(environment, kind)}
            />
          ))}
        </div>
      )}
      <Dialog
        isOpen={intent !== undefined}
        onOpenChange={(open) => {
          if (!open) setIntent(undefined)
        }}
        title={`${intent?.kind === 'retry' ? 'Retry' : 'Deploy'} ${tag} to ${intent?.environment.name ?? ''}`}
        description={repo.path}
        footer={
          <>
            <Button variant="tertiary" onPress={() => setIntent(undefined)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={() => intent && start(intent)}
              isPending={actions.deploy.isPending}
              isDisabled={intent?.environment.status === 'waiting' && !force}
            >
              Start
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Starts the job{' '}
          <span className="font-mono">{intent?.environment.job ?? intent?.environment.name}</span>{' '}
          of the <span className="font-mono">{tag}</span> pipeline. Holtkeeper follows it and
          records whether it succeeded or failed.
        </p>
        {intent?.environment.status === 'waiting' ? (
          <Checkbox
            label={`${intent.environment.after} is not deployed yet; deploy anyway`}
            isSelected={force}
            onChange={setForce}
          />
        ) : null}
      </Dialog>
    </Panel>
  )
}
