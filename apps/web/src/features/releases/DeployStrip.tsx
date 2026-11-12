import type {
  DeployState,
  EnvironmentState,
  PersonView,
  ReleaseRepoView,
  RepoRef,
} from '@holtkeeper/api'
import { Play, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useReleaseActions, useReleaseDeploy } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { environmentTag } from '../../lib/release-overview.ts'
import {
  type DeployKind,
  attemptLine,
  deployKind,
  deployKindLabel,
  environmentOrder,
} from '../../lib/release-timeline.ts'
import { repoKey } from '../../lib/repo.ts'
import { Button, Checkbox, Dialog, Tag, TextField, notify } from '../../ui/index.ts'

type Intent = { environment: EnvironmentState; kind: DeployKind }

function useDeployFlow(repo: RepoRef, tag: string, onStarted: () => void) {
  const actions = useReleaseActions()
  const [intent, setIntent] = useState<Intent>()
  const [force, setForce] = useState(false)
  const [reason, setReason] = useState('')
  const close = () => {
    setIntent(undefined)
    setForce(false)
    setReason('')
  }
  const start = (current: Intent) =>
    actions.deploy.mutate(
      {
        repo: repoKey(repo),
        tag,
        environment: current.environment.name,
        ...(current.kind === 'redeploy' ? { redeploy: true } : {}),
        ...(force ? { force: true } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      {
        onSuccess: (result) => {
          close()
          notify.success(
            result.dryRun ? `Dry run: ${result.detail}` : result.detail,
            'Holtkeeper follows the job and records how it ends.',
          )
          onStarted()
        },
        onError: (error) => notify.error('Not started', messageOf(error)),
      },
    )
  const request = (environment: EnvironmentState, kind: DeployKind) => {
    const next = { environment, kind }
    if (environment.confirm || environment.status === 'waiting' || kind !== 'deploy')
      setIntent(next)
    else start(next)
  }
  const dialog = (
    <Dialog
      isOpen={intent !== undefined}
      onOpenChange={(open) => {
        if (!open) close()
      }}
      title={`${intent ? deployKindLabel[intent.kind] : 'Deploy'} ${tag} to ${intent?.environment.name ?? ''}`}
      description={repo.path}
      footer={
        <>
          <Button variant="tertiary" onPress={close}>
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
      <TextField
        label="Reason"
        description="Kept on the attempt and in the history."
        placeholder={intent?.kind === 'retry' ? 'Runner lost' : 'Hotfix for the checkout form'}
        value={reason}
        onChange={setReason}
      />
      {intent?.environment.status === 'waiting' ? (
        <Checkbox
          label={`${intent.environment.after} is not deployed yet; deploy anyway`}
          isSelected={force}
          onChange={setForce}
        />
      ) : null}
    </Dialog>
  )
  return { request, dialog }
}

function DeployButton({
  environment,
  onRun,
}: {
  environment: EnvironmentState
  onRun: (kind: DeployKind) => void
}) {
  const kind = deployKind(environment.status)
  if (!kind) return null
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={`${deployKindLabel[kind]}: ${environment.name}`}
      onPress={() => onRun(kind)}
    >
      {kind === 'deploy' ? <Play className="size-3.5" /> : <RotateCcw className="size-3.5" />}
      {deployKindLabel[kind]}
    </Button>
  )
}

/**
 * Where the latest version runs: one card per configured environment with its deploy status, the
 * version it runs now, its job and order, and the newest attempt. People with `releases:run` start,
 * retry or repeat the deploy behind a confirmation with a reason; polls while a job runs.
 */
export function EnvironmentsPanel({ repo, view }: { repo: RepoRef; view: ReleaseRepoView }) {
  const tag = view.deploy?.tag
  const deploy = useReleaseDeploy(repo, tag, view.deploy)
  const flow = useDeployFlow(repo, tag ?? '', () => void deploy.refetch())
  const configured = view.settings.deploy.environments
  if (!configured.length) return null
  const states = deploy.data?.environments ?? view.deploy?.environments ?? []
  const editable = view.can.run && !view.readOnly && tag !== undefined
  return (
    <section aria-label="Environments" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-[13px] font-semibold">Environments</h2>
        <span className="text-xs text-muted">
          {tag ? (
            <>
              latest version <span className="mono">{tag}</span> · deploy jobs run from the tag
              pipeline
            </>
          ) : (
            'no version yet'
          )}
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {configured.map((settings) => {
          const summary = view.row.environments.find((env) => env.name === settings.name)
          const state = states.find((env) => env.name === settings.name)
          const status = state?.status ?? summary?.status ?? 'no-pipeline'
          const latest = state?.attempts[0]
          const duration = latest ? attemptLine(latest, view.people).duration : undefined
          return (
            <div
              key={settings.name}
              className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono text-[13px] font-medium">{settings.name}</span>
                <Tag tone={environmentTag(status).tone} dot>
                  {environmentTag(status).label}
                </Tag>
                {summary?.tag ? (
                  <span className="mono text-xs text-muted">{summary.tag}</span>
                ) : null}
                <span className="flex-1" />
                {editable && state ? (
                  <DeployButton environment={state} onRun={(kind) => flow.request(state, kind)} />
                ) : null}
              </div>
              <div className="text-xs text-muted">
                Job <span className="mono">{settings.job ?? settings.name}</span> ·{' '}
                {environmentOrder(settings)}
                {latest ? (
                  <>
                    {' '}
                    · attempt{' '}
                    <a
                      href={latest.webUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mono hover:underline"
                    >
                      #{state.attempts.length}
                    </a>
                    {latest.startedAt ? ` ${formatRelative(latest.startedAt)}` : ''}
                    {duration ? ` · ${duration}` : ''}
                  </>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      {flow.dialog}
    </section>
  )
}

function Attempts({
  environment,
  people,
}: {
  environment: EnvironmentState
  people: Readonly<Record<string, PersonView>>
}) {
  if (!environment.attempts.length)
    return <p className="text-xs text-muted">Not run for this version yet.</p>
  return (
    <ol className="flex flex-col gap-1 text-xs">
      {environment.attempts.map((attempt, index) => {
        const line = attemptLine(attempt, people)
        return (
          <li key={attempt.jobId} className="flex flex-wrap items-center gap-2">
            <a
              href={attempt.webUrl}
              target="_blank"
              rel="noreferrer"
              className="mono w-7 text-muted hover:underline"
            >
              #{environment.attempts.length - index}
            </a>
            <Tag tone={line.tone} dot>
              {line.status}
            </Tag>
            <span className="min-w-0 text-muted">
              {[
                attempt.startedAt ? formatDateTime(attempt.startedAt) : undefined,
                line.by,
                line.reason,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <span className="flex-1" />
            {line.duration ? <span className="mono text-dim">{line.duration}</span> : null}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Deploys of one version, per environment: its status, every attempt with who started it through
 * Holtkeeper and why, and the deploy, retry or repeat action for people with `releases:run`.
 */
export function VersionDeploys({
  repo,
  view,
  tag,
  initial,
  people,
}: {
  repo: RepoRef
  view: ReleaseRepoView
  tag: string
  initial?: DeployState | undefined
  people: Readonly<Record<string, PersonView>>
}) {
  const deploy = useReleaseDeploy(repo, tag, initial)
  const flow = useDeployFlow(repo, tag, () => void deploy.refetch())
  const environments = deploy.data?.environments ?? initial?.environments ?? []
  if (!view.settings.deploy.environments.length || !environments.length)
    return <p className="text-sm text-muted">This repository deploys nowhere.</p>
  const editable = view.can.run && !view.readOnly
  return (
    <div className="flex flex-col gap-3">
      {environments.map((environment) => (
        <div
          key={environment.name}
          className="flex flex-col gap-2 rounded-xl border border-line px-3 py-2.5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-[13px] font-medium">{environment.name}</span>
            <Tag tone={environmentTag(environment.status).tone} dot>
              {environmentTag(environment.status).label}
            </Tag>
            <span className="flex-1" />
            {editable ? (
              <DeployButton
                environment={environment}
                onRun={(kind) => flow.request(environment, kind)}
              />
            ) : null}
          </div>
          <Attempts environment={environment} people={people} />
          {environment.after || environment.confirm ? (
            <span className="text-xs text-dim">{environmentOrder(environment)}</span>
          ) : null}
        </div>
      ))}
      {flow.dialog}
    </div>
  )
}
