import { groupsMatch } from '@holtkeeper/access'
import { releaseTarget } from '@holtkeeper/changelog'
import { resolveRepo } from '@holtkeeper/core'
import type {
  BranchPushedEvent,
  ForgeEvent,
  GitForge,
  MergeRequest,
  MergeRequestChangedEvent,
  NoteAddedEvent,
  PipelineDoneEvent,
  RepoRef,
  TagPushedEvent,
} from '@holtkeeper/forge'
import {
  type MergeRequestEvent,
  type MergeRequestEventAction,
  type PolicyEvaluation,
  type PolicyMemory,
  combinePolicies,
  createMemory,
  evaluatePolicies,
  policiesSettingKey,
} from '@holtkeeper/mr-policies'
import type { JobTrigger, KvStore } from '@holtkeeper/store'
import { z } from 'zod'

import { type ServerDeps, repoTarget } from './context.ts'
import { defaultBranchOf, pushChangesDependencies } from './dependency-refresh.ts'
import { librariesConfigOf, librariesEnabled } from './libraries.ts'

/** Every note Holtkeeper posts carries this marker. */
const OWN_MARKER = 'holtkeeper:review'

/** Bot usernames GitLab gives project and group access tokens, plus GitHub-style `[bot]` names. */
const DEFAULT_BOT_GLOBS = ['project_*_bot*', 'group_*_bot*', '*[bot]']

/** How long a done policy action is remembered (per head commit). */
const POLICY_MEMORY_TTL_SECONDS = 90 * 86_400

interface JobRequest {
  analyzer: string
  repo: RepoRef
  group?: string
  ref?: string
  options?: Record<string, unknown>
}

/** What handling one event did: the jobs it queued, or why it queued nothing. */
export interface EventOutcome {
  enqueued: string[]
  ignored?: string
}

/** Where an event came from: the activity log actor and how queued jobs are marked. */
interface EventSource {
  /** E.g. `webhook:gitlab`, `poll`. */
  actor: string
  via: 'webhook' | 'poll'
}

/** Handles a forge event: runs policies and queues the analyzers the config asks for. */
export type EventDispatcher = (event: ForgeEvent, source: EventSource) => Promise<EventOutcome>

const ignore = (reason: string): EventOutcome => ({ enqueued: [], ignored: reason })

/** A `/holtkeeper <name> [args]` command in a note, from its first line that has one. */
export function parseCommand(note: string): { name: string; args: string[] } | undefined {
  for (const line of note.split('\n')) {
    const match = /^\s*\/holtkeeper\s+([a-z][\w-]*)(.*)$/.exec(line)
    if (match?.[1])
      return { name: match[1], args: (match[2] ?? '').trim().split(/\s+/).filter(Boolean) }
  }
  return undefined
}

/**
 * Options from command arguments: `key=value` pairs by name, the rest by position onto `names`;
 * when there are more positional arguments than names, the last name gets the rest as a list.
 * Positional arguments without a name are dropped.
 */
export function commandOptions(
  args: readonly string[],
  names: readonly string[] = [],
): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  const positional: string[] = []
  for (const arg of args) {
    const separator = arg.indexOf('=')
    if (separator > 0) options[arg.slice(0, separator)] = arg.slice(separator + 1)
    else positional.push(arg)
  }
  names.forEach((name, index) => {
    const isLast = index === names.length - 1
    const values = isLast ? positional.slice(index) : positional.slice(index, index + 1)
    if (values.length === 0) return
    options[name] = isLast && values.length > 1 ? values : values[0]
  })
  return options
}

/** The policy event for a merge request change, or `undefined` for actions policies do not see. */
export function mergeRequestAction(
  action: string | undefined,
  newCommits: boolean,
  labelsAdded: readonly string[],
): MergeRequestEventAction | undefined {
  if (action === 'open' || action === 'reopen' || action === 'merge') return action
  if (action === 'approved') return 'approve'
  if (action === 'update') return newCommits ? 'update' : labelsAdded.length ? 'label' : undefined
  return undefined
}

/** `PolicyMemory` in the store's key-value part, keys `policy:<engine key>`. */
function kvPolicyMemory(kv: KvStore): PolicyMemory {
  return {
    seen: async (key) => (await kv.get(`policy:${key}`)) !== undefined,
    remember: (key) => kv.set(`policy:${key}`, true, POLICY_MEMORY_TTL_SECONDS),
  }
}

/** The merge request as the forge has it, else as the event describes it. */
const loadMergeRequest = async (
  forge: GitForge | undefined,
  repo: RepoRef,
  iid: number,
  fallback: MergeRequest & { headSha?: string },
): Promise<MergeRequest & { headSha?: string }> => {
  if (forge?.getMergeRequest) {
    try {
      return await forge.getMergeRequest(repo.path, iid)
    } catch {
      // The event is good enough for most conditions; the engine loads what is missing.
    }
  }
  return fallback
}

const stub = (iid: number, state: MergeRequest['state'], headSha?: string) => ({
  id: iid,
  title: '',
  description: '',
  sourceBranch: '',
  targetBranch: '',
  state,
  draft: false,
  labels: [],
  author: '',
  webUrl: '',
  ...(headSha && { headSha }),
})

/**
 * How Holtkeeper reacts to forge events, whether a webhook delivered them or polling found them:
 *
 * - Tags queue `jobs.onTag.analyzers` with `ref` = the tag.
 * - Branch pushes matching `jobs.onPush.branches` queue `jobs.onPush.analyzers` with `ref` = the
 *   pushed commit and `{ branch }` as options; a job of an older commit of that branch still queued
 *   is canceled, so only the newest push runs.
 * - Merge request changes run merge request policies (`mergeRequests.policies`), write every
 *   outcome to the activity log, then queue `jobs.onMergeRequest.analyzers` (open, new commits,
 *   reopen) and `jobs.onLabel[label]` for added labels minus the policies' `skipAnalyzers`, plus
 *   their `enqueue` intents, with `{ mergeRequest: iid }` and `ref` = head sha.
 * - Notes: `/holtkeeper <command>` runs policies as a `command` event and queues
 *   `jobs.commands[command]`; a reply in a thread Holtkeeper started queues `review` with
 *   `{ mergeRequest, replyTo: discussionId }`.
 * - Finished merge request pipelines for the head run policies as `update`, so deferred approvals
 *   and merges happen; only `enqueue` intents are queued.
 *
 * Events of repositories `deps.readOnly` marks read-only are ignored, except tags and pushes. Events by
 * `jobs.botUsername` or carrying Holtkeeper's note marker are ignored. A job already
 * queued or running with the same ref and options is not queued again, so the same change seen
 * by a webhook and by polling runs once.
 */
export function createEventDispatcher(deps: ServerDeps): EventDispatcher {
  const { store, config } = deps
  const analyzers = new Map((deps.analyzers ?? []).map((analyzer) => [analyzer.kind, analyzer]))
  const memory: PolicyMemory = store.kv ? kvPolicyMemory(store.kv) : createMemory()

  const enqueue = async (requests: JobRequest[], trigger: JobTrigger) => {
    const now = deps.now().toISOString()
    const enqueued: string[] = []
    for (const request of requests) {
      const active = await store.jobs.list({
        status: ['queued', 'running'],
        repo: request.repo,
        analyzer: request.analyzer,
        limit: 500,
      })
      const options = JSON.stringify(request.options ?? {})
      const duplicate = active.some(
        (job) =>
          (job.ref ?? '') === (request.ref ?? '') &&
          (request.options === undefined || JSON.stringify(job.options) === options),
      )
      if (duplicate) continue
      const job = await store.jobs.enqueue({ ...request, trigger, createdAt: now })
      enqueued.push(job.id)
    }
    return enqueued
  }

  const botUsername = () => config.jobs?.botUsername
  const fromBot = (username: string | undefined) =>
    botUsername() !== undefined && username === botUsername()

  /** Posts a short note; failures do not fail the event. */
  const acknowledge = async (
    repo: RepoRef,
    mergeRequest: number,
    discussionId: string | undefined,
    text: string,
  ) => {
    try {
      const forge = config.forges[repo.forge]?.create()
      if (!forge) return
      const body = `${text}\n\n<!-- ${OWN_MARKER} ack -->`
      if (discussionId && forge.replyToDiscussion)
        await forge.replyToDiscussion(repo.path, mergeRequest, discussionId, body)
      else await forge.commentOnMergeRequest(repo.path, mergeRequest, body)
    } catch {
      // The job is queued either way; a missing acknowledgement is not worth a failed event.
    }
  }

  const isOurThread = async (repo: RepoRef, mergeRequest: number, discussionId: string) => {
    const forge = config.forges[repo.forge]?.create()
    if (!forge?.listDiscussions) return false
    const discussion = (await forge.listDiscussions(repo.path, mergeRequest)).find(
      (d) => d.id === discussionId,
    )
    const notes = discussion?.notes.filter((note) => !note.system) ?? []
    const first = notes[0]
    if (!first || notes.length < 2) return false
    const bot = botUsername()
    return first.body.includes(OWN_MARKER) || (bot !== undefined && first.author === bot)
  }

  const repoAnalyzers = (kinds: readonly string[]) =>
    kinds.filter((kind) => analyzers.get(kind)?.scope !== 'group')

  /** Configured analyzers minus what policies skip, plus what they ask for. */
  const withPolicies = (
    kinds: Iterable<string>,
    policy: PolicyEvaluation | undefined,
  ): { analyzer: string; options?: Record<string, unknown> }[] => {
    const skip = policy?.skipAnalyzers ?? []
    const kept =
      skip === '*'
        ? []
        : [...kinds].filter((kind) => !skip.includes(kind)).map((analyzer) => ({ analyzer }))
    const extra = (policy?.enqueue ?? []).filter(
      (intent) => analyzers.get(intent.analyzer)?.scope !== 'group',
    )
    return [
      ...kept,
      ...extra.filter(
        (intent) => !kept.some((k) => k.analyzer === intent.analyzer && !intent.options),
      ),
    ]
  }

  const handlers = (source: EventSource) => {
    const trigger = (fallback: JobTrigger): JobTrigger =>
      source.via === 'poll' ? 'poll' : fallback

    const activity = (action: string, repo: RepoRef, details: Record<string, unknown>) =>
      store.activity.append({
        at: deps.now().toISOString(),
        actor: source.actor,
        action,
        subject: `${repo.forge}:${repo.path}`,
        details,
      })

    /**
     * Runs the merge request policies that cover the repository and logs every outcome. Without
     * policies nothing is loaded from the forge. Never throws: a failure is logged and treated as
     * "no policy applied".
     */
    const runPolicies = async (
      repo: RepoRef,
      input: Omit<MergeRequestEvent, 'repo' | 'groups' | 'mr' | 'isBot'> & {
        iid: number
        mr: MergeRequest & { headSha?: string }
      },
    ): Promise<PolicyEvaluation | undefined> => {
      const target = repoTarget(config, repo)
      const { policies, invalid } = combinePolicies(
        await store.settings.list(policiesSettingKey),
        target,
      )
      for (const problem of invalid) await activity('mr_policy.invalid', repo, { ...problem })
      if (policies.length === 0) return undefined
      const botUser = botUsername()
      try {
        const forge = config.forges[repo.forge]?.create()
        if (!forge) return undefined
        const { iid, mr: fallback, ...rest } = input
        const event: MergeRequestEvent = {
          ...rest,
          repo,
          groups: target.groups,
          mr: await loadMergeRequest(forge, repo, iid, fallback),
          isBot: botUser !== undefined && input.actor === botUser,
        }
        const result = await evaluatePolicies({
          policies,
          event,
          forge,
          now: deps.now(),
          dryRun: config.dryRun,
          memory,
          ...(botUser !== undefined && { botUser }),
          bots: [...(botUser ? [botUser] : []), ...DEFAULT_BOT_GLOBS],
        })
        for (const outcome of result.outcomes)
          await activity(`mr_policy.${outcome.status}`, repo, {
            mergeRequest: iid,
            event: event.action,
            policy: outcome.policyId,
            action: outcome.action,
            detail: outcome.detail,
          })
        return result
      } catch (error) {
        await activity('mr_policy.error', repo, {
          mergeRequest: input.iid,
          error: error instanceof Error ? error.message : String(error),
        })
        return undefined
      }
    }

    const handleTag = async ({ repo, tag, sha }: TagPushedEvent): Promise<EventOutcome> => {
      const onTag = config.jobs?.onTag
      if (!onTag) return ignore('jobs.onTag is not configured')
      const repoGroups = resolveRepo(config, repo).groups
      if (onTag.groups && !groupsMatch(onTag.groups, repoGroups))
        return ignore('repository is not in jobs.onTag.groups')
      const groups = onTag.groups
        ? repoGroups.filter((group) => onTag.groups?.includes(group))
        : repoGroups
      const requests = onTag.analyzers.flatMap((analyzer): JobRequest[] =>
        analyzers.get(analyzer)?.scope === 'group'
          ? groups.map((group) => ({ analyzer, repo: { forge: repo.forge, path: group }, group }))
          : [{ analyzer, repo, ref: releaseTarget({ name: tag, sha }) }],
      )
      const enqueued = await enqueue(requests, trigger('tag'))
      await activity('job.tag_pushed', repo, { tag, jobs: enqueued })
      return { enqueued }
    }

    /**
     * A push to the default branch that changed a manifest or lockfile (or whose changes cannot be
     * told) queues `usages` for the repository and `fleet` for its groups while the library index
     * and its `refreshOnPush` are on, so the index sees new packages and versions soon.
     */
    const refreshDependencies = async (event: BranchPushedEvent): Promise<string[]> => {
      if (!analyzers.has('usages') && !analyzers.has('fleet')) return []
      const settings = await librariesConfigOf(store.settings)
      if (!settings || !librariesEnabled(settings) || !settings.refreshOnPush) return []
      const { repo, branch, sha } = event
      const forge = config.forges[repo.forge]?.create()
      if ((await defaultBranchOf(event, forge)) !== branch) return []
      if ((await pushChangesDependencies(event, forge)) === false) return []
      if (analyzers.has('usages')) {
        const stale = await store.jobs.list({
          status: ['queued'],
          repo,
          analyzer: 'usages',
          limit: 500,
        })
        for (const job of stale)
          if (job.options['branch'] === branch && job.ref !== sha)
            // oxlint-disable-next-line no-await-in-loop -- few jobs, and order does not matter
            await store.jobs.cancel(job.id, deps.now().toISOString())
      }
      const requests: JobRequest[] = [
        ...(analyzers.has('usages')
          ? [{ analyzer: 'usages', repo, ref: sha, options: { branch } }]
          : []),
        ...(analyzers.get('fleet')?.scope === 'group'
          ? resolveRepo(config, repo).groups.map((group) => ({
              analyzer: 'fleet',
              repo: { forge: repo.forge, path: group },
              group,
            }))
          : []),
      ]
      const enqueued = await enqueue(requests, trigger('push'))
      if (enqueued.length)
        await activity('job.dependencies_changed', repo, { branch, sha, jobs: enqueued })
      return enqueued
    }

    const handlePush = async (event: BranchPushedEvent): Promise<EventOutcome> => {
      const refreshed = await refreshDependencies(event)
      const outcome = await handleConfiguredPush(event)
      return refreshed.length ? { enqueued: [...refreshed, ...outcome.enqueued] } : outcome
    }

    const handleConfiguredPush = async ({ repo, branch, sha, actor }: BranchPushedEvent) => {
      const onPush = config.jobs?.onPush
      if (!onPush) return ignore('jobs.onPush is not configured')
      if (fromBot(actor)) return ignore('event from the bot user')
      if (onPush.branches && !onPush.branches.some((glob) => new Bun.Glob(glob).match(branch)))
        return ignore('branch is not in jobs.onPush.branches')
      if (onPush.groups && !groupsMatch(onPush.groups, resolveRepo(config, repo).groups))
        return ignore('repository is not in jobs.onPush.groups')
      const kinds = repoAnalyzers(onPush.analyzers)
      for (const analyzer of kinds) {
        const stale = await store.jobs.list({ status: ['queued'], repo, analyzer, limit: 500 })
        for (const job of stale)
          if (job.options.branch === branch && job.ref !== sha)
            // oxlint-disable-next-line no-await-in-loop -- few jobs, and order does not matter
            await store.jobs.cancel(job.id, deps.now().toISOString())
      }
      const enqueued = await enqueue(
        kinds.map((analyzer) => ({ analyzer, repo, ref: sha, options: { branch } })),
        trigger('push'),
      )
      await activity('job.branch_pushed', repo, { branch, sha, jobs: enqueued })
      return { enqueued }
    }

    const handleMergeRequest = async (event: MergeRequestChangedEvent): Promise<EventOutcome> => {
      const { repo, mr } = event
      if (fromBot(event.actor)) return ignore('event from the bot user')
      const head = mr.headSha
      const policyAction = mergeRequestAction(
        event.action,
        event.newCommits || event.leftDraft,
        event.labelsAdded,
      )
      const policy = policyAction
        ? await runPolicies(repo, {
            iid: mr.id,
            action: policyAction,
            actor: event.actor,
            ...(event.labelsAdded.length && { labelsAdded: event.labelsAdded }),
            mr,
          })
        : undefined
      if (mr.state === 'closed' || mr.state === 'merged')
        return ignore(`merge request is ${mr.state}`)

      const kinds = new Set<string>()
      const reasons: string[] = []
      const onMergeRequest = config.jobs?.onMergeRequest
      if (onMergeRequest) {
        const action =
          event.action === 'open' || event.action === 'reopen'
            ? event.action
            : event.action === 'update' && (event.newCommits || event.leftDraft)
              ? 'update'
              : undefined
        const actions = onMergeRequest.actions ?? ['open', 'update', 'reopen']
        const groups = resolveRepo(config, repo).groups
        if (!action) reasons.push(`action ${event.action || '(none)'} brings no new commits`)
        else if (!actions.includes(action)) reasons.push(`action ${action} is not configured`)
        else if (mr.draft && !onMergeRequest.draft) reasons.push('merge request is a draft')
        else if (onMergeRequest.groups && !groupsMatch(onMergeRequest.groups, groups))
          reasons.push('repository is not in jobs.onMergeRequest.groups')
        else for (const kind of repoAnalyzers(onMergeRequest.analyzers)) kinds.add(kind)
      }
      for (const label of event.labelsAdded)
        for (const kind of repoAnalyzers(config.jobs?.onLabel?.[label] ?? [])) kinds.add(kind)

      const planned = withPolicies(kinds, policy)
      if (planned.length === 0)
        return ignore(
          kinds.size > 0
            ? 'policies skipped every analyzer'
            : reasons.join('; ') || 'no analyzers configured for this event',
        )
      const enqueued = await enqueue(
        planned.map(({ analyzer, options }) => ({
          analyzer,
          repo,
          ...(head ? { ref: head } : {}),
          options: { ...options, mergeRequest: mr.id },
        })),
        trigger('webhook'),
      )
      await activity('job.merge_request', repo, {
        mergeRequest: mr.id,
        action: event.action,
        labels: event.labelsAdded,
        jobs: enqueued,
      })
      return { enqueued }
    }

    const handleNote = async (event: NoteAddedEvent): Promise<EventOutcome> => {
      const { repo, mergeRequest: iid, headSha: head } = event
      if (fromBot(event.author) || event.body.includes(OWN_MARKER))
        return ignore('event from the bot user')
      const request = (analyzer: string, options: Record<string, unknown>): JobRequest => ({
        analyzer,
        repo,
        ...(head ? { ref: head } : {}),
        options: { mergeRequest: iid, ...options },
      })

      const command = parseCommand(event.body)
      if (command) {
        const policy = await runPolicies(repo, {
          iid,
          action: 'command',
          command: command.name,
          actor: event.author,
          mr: stub(iid, event.mergeRequestState, head),
        })
        const intents = withPolicies([], policy)
        const fromPolicies = intents.length
          ? await enqueue(
              intents.map(({ analyzer, options }) => request(analyzer, options ?? {})),
              trigger('webhook'),
            )
          : []
        const commands = config.jobs?.commands
        const definition = commands?.[command.name]
        if (!definition && policy?.matched.length) return { enqueued: fromPolicies }
        if (!commands) return ignore('jobs.commands is not configured')
        if (!definition) {
          const available = Object.keys(commands)
            .map((name) => `\`${name}\``)
            .join(', ')
          await acknowledge(
            repo,
            iid,
            event.discussionId,
            `Unknown command \`${command.name}\`. Available: ${available}.`,
          )
          return ignore(`unknown command ${command.name}`)
        }
        const job = request(definition.analyzer, commandOptions(command.args, definition.args))
        const checked = analyzers.get(definition.analyzer)?.options.safeParse(job.options)
        if (checked && !checked.success) {
          await acknowledge(
            repo,
            iid,
            event.discussionId,
            `Could not run \`${command.name}\`:\n\n${z.prettifyError(checked.error)}`,
          )
          return ignore('invalid command options')
        }
        const skip = policy?.skipAnalyzers ?? []
        const enqueued =
          skip === '*' || skip.includes(job.analyzer)
            ? fromPolicies
            : [...fromPolicies, ...(await enqueue([job], trigger('webhook')))]
        await acknowledge(
          repo,
          iid,
          event.discussionId,
          enqueued.length
            ? `Queued \`${command.name}\` (job ${enqueued.join(', ')}).`
            : `\`${command.name}\` is already queued for this commit.`,
        )
        await activity('job.command', repo, {
          mergeRequest: iid,
          command: command.name,
          ...(event.author && { author: event.author }),
          jobs: enqueued,
        })
        return { enqueued }
      }

      const discussionId = event.discussionId
      if (!discussionId || !event.inThread) return ignore('note is not a reply in a thread')
      if (!(await isOurThread(repo, iid, discussionId)))
        return ignore('thread was not started by Holtkeeper')
      const analyzer = config.jobs?.commands?.review?.analyzer ?? 'review'
      const enqueued = await enqueue(
        [request(analyzer, { replyTo: discussionId })],
        trigger('webhook'),
      )
      await activity('job.thread_reply', repo, { mergeRequest: iid, discussionId, jobs: enqueued })
      return { enqueued }
    }

    const handlePipeline = async (event: PipelineDoneEvent): Promise<EventOutcome> => {
      const { repo, mergeRequest: iid, sha } = event
      if (event.status !== 'success' && event.status !== 'failed')
        return ignore(`pipeline is ${event.status}`)
      const client = config.forges[repo.forge]?.create()
      if (client?.getMergeRequest) {
        try {
          const current = await client.getMergeRequest(repo.path, iid)
          if (current.headSha && current.headSha !== sha)
            return ignore('pipeline is not for the merge request head')
        } catch {
          // Evaluate anyway; the engine checks the head itself.
        }
      }
      const policy = await runPolicies(repo, {
        iid,
        action: 'update',
        actor: event.actor,
        mr: stub(iid, 'open', sha),
      })
      const intents = withPolicies([], policy)
      if (!intents.length) return ignore(policy ? 'policies queued nothing' : 'no policies apply')
      const enqueued = await enqueue(
        intents.map(({ analyzer, options }) => ({
          analyzer,
          repo,
          ref: sha,
          options: { ...options, mergeRequest: iid },
        })),
        trigger('webhook'),
      )
      return { enqueued }
    }

    return { handleTag, handlePush, handleMergeRequest, handleNote, handlePipeline }
  }

  return async (event, source) => {
    if (event.kind !== 'tag' && event.kind !== 'push' && (await deps.readOnly?.(event.repo)))
      return ignore('the repository is read-only')
    const handle = handlers(source)
    if (event.kind === 'tag') return handle.handleTag(event)
    if (event.kind === 'push') return handle.handlePush(event)
    if (event.kind === 'mergeRequest') return handle.handleMergeRequest(event)
    if (event.kind === 'note') return handle.handleNote(event)
    return handle.handlePipeline(event)
  }
}
