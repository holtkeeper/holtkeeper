import type { ReleaseRepoView } from '@holtkeeper/api'
import {
  type Card,
  type CardAction,
  type CardStep,
  type ChatCommandContext,
  ChatUserError,
  type PostedMessage,
  type StepStatus,
  defineCommand,
} from '@holtkeeper/chat'
import type { RepoRef } from '@holtkeeper/forge'
import { type DeployState, type DeployStatus, GateError } from '@holtkeeper/release'
import { z } from 'zod'

import type { ServerDeps } from './context.ts'
import { releaseServiceFor } from './releases.ts'

const repoKeyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const deployStatuses: Record<DeployStatus, { status: StepStatus; text: string }> = {
  'no-pipeline': { status: 'pending', text: 'no tag pipeline yet' },
  missing: { status: 'skipped', text: 'no deploy job' },
  waiting: { status: 'waiting', text: 'waits for an earlier environment' },
  ready: { status: 'pending', text: 'ready to deploy' },
  pending: { status: 'running', text: 'queued' },
  running: { status: 'running', text: 'deploying' },
  success: { status: 'done', text: 'deployed' },
  failed: { status: 'failed', text: 'failed' },
  canceled: { status: 'failed', text: 'canceled' },
  skipped: { status: 'skipped', text: 'skipped' },
}

/** Deploy state of one version as card steps, one per environment. */
function deploySteps(state: DeployState): CardStep[] {
  return state.environments.map((environment) => {
    const shown = deployStatuses[environment.status]
    const url = environment.attempts[0]?.webUrl
    return {
      label: environment.name,
      status: shown.status,
      detail: `${shown.text}${environment.auto ? ', automatic' : ''}`,
      ...(url && { url }),
    }
  })
}

/** The card of a running or finished deploy of `state.tag`. */
export function deployCard(repo: RepoRef, state: DeployState, url?: string): Card {
  const steps = deploySteps(state)
  const failed = steps.some((step) => step.status === 'failed')
  const busy = steps.some((step) => step.status === 'running')
  return {
    title: `Deploy ${state.tag} · ${repo.path}`,
    tone: failed ? 'bad' : busy ? 'info' : 'good',
    ...(url && { url }),
    blocks: [{ type: 'steps', steps }],
  }
}

/** A live card that follows the deploys of one version. */
export interface LiveDeploy {
  posted: PostedMessage
  repo: RepoRef
  tag: string
}

interface ReleaseCommandDeps {
  deps: ServerDeps
  /** The panel page of a repository's releases, when the public URL is known. */
  pageOf: (repo: RepoRef) => string | undefined
  /** Remembers a posted deploy card so release events update it. */
  follow: (live: LiveDeploy) => Promise<void>
}

const options = z.object({
  step: z.enum(['status', 'propose', 'accept', 'version', 'deploy']).default('status'),
  environment: z.string().min(1).optional(),
  repo: z
    .string()
    .regex(/^[a-z0-9][\w-]*:.+$/, 'expected <forge>:<path>')
    .optional(),
  tag: z.string().min(1).optional(),
  note: z.string().optional(),
  yes: z.preprocess((value) => value === true || value === 'true', z.boolean()),
})

type Options = z.infer<typeof options>

/** Step failures as answers: failing gates as a card, other errors with their message. */
const stepFailure = (error: unknown): never => {
  if (error instanceof GateError)
    throw new ChatUserError(error.message, {
      title: 'Release gates failed',
      tone: 'bad',
      blocks: [
        {
          type: 'list',
          items: error.gates
            .filter((gate) => !gate.ok)
            .map((gate) => ({ text: gate.message, tone: 'bad' as const })),
        },
      ],
    })
  if (error instanceof Error) throw new ChatUserError(error.message)
  throw error
}

/** The `release` command: the release state of a repository and its steps, with confirmations. */
export function releaseCommand({ deps, pageOf, follow }: ReleaseCommandDeps) {
  const releases = releaseServiceFor(deps)

  const targetOf = (context: ChatCommandContext<Options>): RepoRef => {
    const named = context.options.repo
    if (named) {
      const separator = named.indexOf(':')
      return { forge: named.slice(0, separator), path: named.slice(separator + 1) }
    }
    if (context.message.repo) return context.message.repo
    throw new ChatUserError(
      `Name the repository: \`/${context.prefix} release repo=<forge>:<path>\`.`,
    )
  }

  /** The command line of a step, with the repository unless the conversation is about it. */
  const line = (context: ChatCommandContext<Options>, repo: RepoRef, ...words: string[]) => {
    const here = context.message.repo
    const sameRepo = here?.forge === repo.forge && here.path === repo.path
    return ['release', ...words, ...(sameRepo ? [] : [`repo=${repoKeyOf(repo)}`])].join(' ')
  }

  const statusCard = (
    context: ChatCommandContext<Options>,
    repo: RepoRef,
    view: ReleaseRepoView,
  ): Card => {
    const { row } = view
    const page = pageOf(repo)
    const fields = [
      { label: 'Stage', value: row.stage },
      ...(row.latest ? [{ label: 'Latest', value: `\`${row.latest.tag}\`` }] : []),
      ...(row.next
        ? [{ label: 'Next', value: `\`${row.next}\`${row.bump ? ` (${row.bump})` : ''}` }]
        : []),
      ...(row.unreleased
        ? [{ label: 'Unreleased', value: `${row.unreleased}${row.unreleasedCapped ? '+' : ''}` }]
        : []),
      ...(row.ahead && row.source
        ? [{ label: `Ahead on ${row.source}`, value: `${row.ahead}${row.aheadCapped ? '+' : ''}` }]
        : []),
      ...(row.request
        ? [{ label: 'Candidate', value: `[!${row.request.id}](${row.request.webUrl})` }]
        : []),
      ...(row.acceptance ? [{ label: 'Accepted by', value: row.acceptance.by }] : []),
    ]
    const failing = [...(view.proposal?.gates ?? []), ...(view.version?.gates ?? [])].filter(
      (gate) => !gate.ok,
    )
    const actions: CardAction[] = []
    if (view.can.run && !view.readOnly && row.mode !== 'external') {
      if (view.proposal)
        actions.push({
          label: 'Open the release candidate',
          command: line(context, repo, 'propose'),
        })
      if (view.version) {
        if (view.settings.acceptance.required && !row.acceptance)
          actions.push({ label: 'Accept the changes', command: line(context, repo, 'accept') })
        actions.push({
          label: `Create ${view.version.tag ?? 'the version'}`,
          command: line(context, repo, 'version'),
          style: 'primary',
        })
      }
      for (const environment of view.deploy?.environments ?? [])
        if (environment.status === 'ready' || environment.status === 'failed')
          actions.push({
            label: `Deploy ${view.deploy?.tag} to ${environment.name}`,
            command: line(context, repo, 'deploy', environment.name, `tag=${view.deploy?.tag}`),
            style: 'danger',
          })
    }
    return {
      title: `Release · ${repo.path}`,
      tone: row.error ? 'bad' : failing.length ? 'warning' : 'info',
      ...(page && { url: page }),
      blocks: [
        ...(row.error ? [{ type: 'text' as const, text: row.error }] : []),
        { type: 'fields', fields },
        ...(failing.length
          ? [
              {
                type: 'list' as const,
                items: failing.map((gate) => ({ text: gate.message, tone: 'bad' as const })),
              },
            ]
          : []),
        ...(view.deploy && view.deploy.environments.length
          ? [{ type: 'steps' as const, steps: deploySteps(view.deploy) }]
          : []),
        ...(actions.length ? [{ type: 'actions' as const, actions }] : []),
        ...(view.dryRun
          ? [{ type: 'context' as const, text: 'Dry run: steps change nothing.' }]
          : []),
      ],
    }
  }

  return defineCommand<Options>({
    name: 'release',
    summary: 'Shows where a repository is in its release flow and runs its steps.',
    usage: '[status|propose|accept|version|deploy <environment>] [repo=<forge>:<path>] [tag=<tag>]',
    positional: ['step', 'environment'],
    options,
    async run(context) {
      const repo = targetOf(context)
      const { step } = context.options
      const page = pageOf(repo)

      if (step === 'status') {
        const principal = await context.require('releases:read', repo)
        const view = await releases.view(principal, repo).catch(stepFailure)
        await context.reply(statusCard(context, repo, view))
        return
      }

      const principal = await context.require('releases:run', repo)
      if (await releases.isReadOnly(repo))
        throw new ChatUserError(`${repo.path} is read-only for Holtkeeper.`)

      if (step === 'propose') {
        const result = await releases.propose(repo, principal.id).catch(stepFailure)
        await context.reply({
          title: `Release candidate · ${repo.path}`,
          tone: 'good',
          ...(result.url && { url: result.url }),
          blocks: [{ type: 'text', text: result.detail }],
        })
        return
      }

      if (step === 'accept') {
        const result = await releases
          .accept(repo, principal.id, context.options.note)
          .catch(stepFailure)
        await context.reply({
          title: `Accepted · ${repo.path}`,
          tone: 'good',
          ...(result.url && { url: result.url }),
          blocks: [{ type: 'text', text: result.detail }],
        })
        return
      }

      if (step === 'version') {
        if (!context.options.yes) {
          const view = await releases.view(principal, repo).catch(stepFailure)
          const plan = view.version
          if (!plan) throw new ChatUserError('Nothing on the target branch waits for a version.')
          const included = plan.entries.filter((entry) => entry.included).length
          await context.reply({
            title: `Create ${plan.tag ?? plan.version ?? 'a version'} of ${repo.path}?`,
            tone: plan.gates.every((gate) => gate.ok) ? 'info' : 'warning',
            ...(page && { url: page }),
            blocks: [
              {
                type: 'fields',
                fields: [
                  { label: 'Changes', value: String(included) },
                  {
                    label: 'Range',
                    value: `${plan.range.fromLabel ?? 'start'} → ${plan.range.toLabel}`,
                  },
                ],
              },
              ...(plan.gates.some((gate) => !gate.ok)
                ? [
                    {
                      type: 'list' as const,
                      items: plan.gates
                        .filter((gate) => !gate.ok)
                        .map((gate) => ({ text: gate.message, tone: 'bad' as const })),
                    },
                  ]
                : []),
              {
                type: 'actions',
                actions: [
                  {
                    label: `Create ${plan.tag ?? 'the version'}`,
                    command: line(context, repo, 'version', '--yes'),
                    style: 'primary',
                  },
                ],
              },
            ],
          })
          return
        }
        const result = await releases.version(repo, principal.id).catch(stepFailure)
        const posted = await context.reply({
          title: `${result.tag ?? 'Version'} · ${repo.path}`,
          tone: 'good',
          ...(result.url && { url: result.url }),
          blocks: [{ type: 'text', text: result.detail }],
        })
        if (result.tag && !result.dryRun)
          await follow({ posted: posted.posted, repo, tag: result.tag })
        return
      }

      const environment = context.options.environment
      if (!environment)
        throw new ChatUserError(
          `Name the environment: \`/${context.prefix} release deploy <environment>\`.`,
        )
      const tag =
        context.options.tag ?? (await releases.view(principal, repo).catch(stepFailure)).deploy?.tag
      if (!tag) throw new ChatUserError(`${repo.path} has no version to deploy yet.`)
      if (!context.options.yes) {
        await context.reply({
          title: `Deploy ${tag} of ${repo.path} to ${environment}?`,
          tone: 'warning',
          ...(page && { url: page }),
          blocks: [
            {
              type: 'actions',
              actions: [
                {
                  label: `Deploy to ${environment}`,
                  command: line(context, repo, 'deploy', environment, `tag=${tag}`, '--yes'),
                  style: 'danger',
                },
              ],
            },
          ],
        })
        return
      }
      const result = await releases
        .deploy(repo, { tag, environment }, principal.id)
        .catch(stepFailure)
      if (result.dryRun) {
        await context.reply({
          title: `Deploy ${tag} · ${repo.path}`,
          blocks: [{ type: 'text', text: result.detail }],
        })
        return
      }
      const state = await releases.deployOf(repo, tag).catch(() => undefined)
      const posted = await context.reply(
        state
          ? deployCard(repo, state, page)
          : {
              title: `Deploy ${tag} · ${repo.path}`,
              blocks: [{ type: 'text', text: result.detail }],
            },
      )
      await follow({ posted: posted.posted, repo, tag })
    },
  })
}
