import type { DeployState, EnvironmentState, ReleaseRepoView, RepoRef } from '@holtkeeper/api'
import { Play, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useReleaseActions, useReleaseDeploy } from '../../api/queries.ts'
import { formatDuration, formatRelative } from '../../lib/format.ts'
import { deployLabels, deployTones } from '../../lib/releases.ts'
import { repoKey } from '../../lib/repo.ts'
import { Button, Checkbox, Dialog, Tag, Tooltip, notify } from '../../ui/index.ts'

type Kind = 'deploy' | 'retry' | 'redeploy'
type Intent = { environment: EnvironmentState; kind: Kind }

const kindOf = (status: EnvironmentState['status']): Kind | undefined =>
  status === 'ready' || status === 'waiting'
    ? 'deploy'
    : status === 'failed' || status === 'canceled'
      ? 'retry'
      : status === 'success'
        ? 'redeploy'
        : undefined

function Attempts({ environment }: { environment: EnvironmentState }) {
  if (!environment.attempts.length)
    return <span>{environment.job ?? environment.name}: not run yet</span>
  return (
    <ol className="flex flex-col gap-0.5 text-xs">
      {environment.attempts.slice(0, 6).map((attempt, index) => (
        <li key={attempt.jobId} className="flex gap-2">
          <span className="mono">#{environment.attempts.length - index}</span>
          <span>{attempt.status}</span>
          {attempt.startedAt ? <span>{formatRelative(attempt.startedAt)}</span> : null}
          {attempt.durationSeconds !== undefined ? (
            <span>{formatDuration(attempt.durationSeconds * 1000)}</span>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function EnvironmentChip({
  environment,
  editable,
  onRun,
}: {
  environment: EnvironmentState
  editable: boolean
  onRun: (kind: Kind) => void
}) {
  const kind = kindOf(environment.status)
  const latest = environment.attempts[0]
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg border border-line bg-raise pl-2.5 pr-1">
      <Tooltip content={<Attempts environment={environment} />}>
        {latest ? (
          <a
            href={latest.webUrl}
            target="_blank"
            rel="noreferrer"
            className="mono text-xs hover:underline"
          >
            {environment.name}
          </a>
        ) : (
          <span tabIndex={0} className="mono text-xs">
            {environment.name}
          </span>
        )}
      </Tooltip>
      <Tag tone={deployTones[environment.status]} dot>
        {deployLabels[environment.status]}
      </Tag>
      {editable && kind ? (
        <Tooltip
          content={kind === 'deploy' ? 'Deploy' : kind === 'retry' ? 'Retry' : 'Deploy again'}
        >
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={`${kind === 'deploy' ? 'Deploy to' : kind === 'retry' ? 'Retry' : 'Deploy again to'} ${environment.name}`}
            onPress={() => onRun(kind)}
          >
            {kind === 'deploy' ? <Play className="size-3.5" /> : <RotateCcw className="size-3.5" />}
          </Button>
        </Tooltip>
      ) : null}
    </div>
  )
}

/**
 * One chip per environment for a version: its deploy status, the job's attempts on hover, and
 * play, retry or redeploy behind a confirmation when the environment asks for one, waits for an
 * earlier environment or already runs the version. Polls while a job runs.
 */
export function DeployStrip({
  repo,
  view,
  tag,
  initial,
}: {
  repo: RepoRef
  view: ReleaseRepoView
  tag: string
  initial?: DeployState | undefined
}) {
  const deploy = useReleaseDeploy(repo, tag, initial)
  const actions = useReleaseActions()
  const [intent, setIntent] = useState<Intent>()
  const [force, setForce] = useState(false)
  const editable = view.can.run && !view.readOnly
  const environments = deploy.data?.environments ?? initial?.environments ?? []
  if (!view.settings.deploy.environments.length || !environments.length) return null

  const start = (current: Intent) =>
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
            'Holtkeeper follows the job and records how it ends.',
          )
          void deploy.refetch()
        },
        onError: (error) => notify.error('Not started', messageOf(error)),
      },
    )
  const request = (environment: EnvironmentState, kind: Kind) => {
    const next = { environment, kind }
    if (environment.confirm || environment.status === 'waiting' || kind === 'redeploy')
      setIntent(next)
    else start(next)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-dim">
        Deploy <span className="mono">{tag}</span>
      </span>
      {environments.map((environment) => (
        <EnvironmentChip
          key={environment.name}
          environment={environment}
          editable={editable}
          onRun={(kind) => request(environment, kind)}
        />
      ))}
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
          <span className="mono">{intent?.environment.job ?? intent?.environment.name}</span> of the{' '}
          <span className="mono">{tag}</span> pipeline. Holtkeeper follows it and records whether it
          succeeded or failed.
        </p>
        {intent?.environment.status === 'waiting' ? (
          <Checkbox
            label={`${intent.environment.after} is not deployed yet; deploy anyway`}
            isSelected={force}
            onChange={setForce}
          />
        ) : null}
      </Dialog>
    </div>
  )
}
