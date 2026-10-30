import { createHash, timingSafeEqual } from 'node:crypto'

import { type HoltkeeperConfig, resolveRepo } from '@holtkeeper/core'
import { type GitForge, type MergeRequest, type RepoRef, resolveSecret } from '@holtkeeper/forge'
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
import type { KvStore } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type AppContext, type Env, type ServerDeps, repoTarget } from '../context.ts'

const projectSchema = z.object({
  path_with_namespace: z.string().min(1),
  web_url: z.string().optional(),
})
const userSchema = z.object({ username: z.string() }).optional()

const tagPushSchema = z.object({
  object_kind: z.literal('tag_push'),
  ref: z.string().startsWith('refs/tags/'),
  after: z.string(),
  project: projectSchema,
})

const labelsSchema = z.array(z.object({ title: z.string() }))

/** GitLab "Merge Request Hook" payload, the fields used here. */
const mergeRequestHookSchema = z.object({
  object_kind: z.literal('merge_request'),
  user: userSchema,
  project: projectSchema,
  labels: labelsSchema.optional(),
  object_attributes: z.object({
    iid: z.number().int().positive(),
    title: z.string().optional(),
    description: z.string().nullish(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    url: z.string().optional(),
    action: z.string().optional(),
    state: z.string().optional(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    /** Present on `update` when commits were pushed. */
    oldrev: z.string().optional(),
    last_commit: z.object({ id: z.string() }).optional(),
  }),
  changes: z
    .object({
      labels: z.object({ previous: labelsSchema, current: labelsSchema }).optional(),
      draft: z
        .object({ previous: z.boolean().nullish(), current: z.boolean().nullish() })
        .optional(),
    })
    .optional(),
})

/** GitLab "Note Hook" payload, the fields used here. */
const noteHookSchema = z.object({
  object_kind: z.literal('note'),
  user: userSchema,
  project: projectSchema,
  object_attributes: z.object({
    id: z.number(),
    note: z.string(),
    noteable_type: z.string(),
    discussion_id: z.string().optional(),
    type: z.string().nullish(),
  }),
  merge_request: z
    .object({
      iid: z.number().int().positive(),
      state: z.string().optional(),
      last_commit: z.object({ id: z.string() }).optional(),
    })
    .optional(),
})

/** GitLab "Pipeline Hook" payload, the fields used here. */
const pipelineHookSchema = z.object({
  object_kind: z.literal('pipeline'),
  user: userSchema,
  project: projectSchema,
  object_attributes: z.object({ id: z.number(), status: z.string(), sha: z.string() }),
  merge_request: z.object({ iid: z.number().int().positive() }).nullish(),
})

const digest = (value: string) => createHash('sha256').update(value).digest()

/** Compares in constant time; hashing first makes lengths equal. */
const sameSecret = (given: string, expected: string) =>
  timingSafeEqual(digest(given), digest(expected))

const deletedSha = /^0+$/

/** Every note Holtkeeper posts carries this marker. */
const OWN_MARKER = 'holtkeeper:review'

interface JobRequest {
  analyzer: string
  repo: RepoRef
  group?: string
  ref?: string
  options?: Record<string, unknown>
}

/** Responses of `POST /api/webhooks/gitlab`. */
interface WebhookResult {
  enqueued: string[]
  ignored?: string
}

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

const addedLabels = (changes: z.infer<typeof mergeRequestHookSchema>['changes']) => {
  if (!changes?.labels) return []
  const before = new Set(changes.labels.previous.map((l) => l.title))
  return changes.labels.current.map((l) => l.title).filter((title) => !before.has(title))
}

const configuredGitlabs = (config: HoltkeeperConfig) =>
  Object.entries(config.forges).filter(([, forge]) => forge.kind === 'gitlab')

/** Bot usernames GitLab gives project and group access tokens, plus GitHub-style `[bot]` names. */
const DEFAULT_BOT_GLOBS = ['project_*_bot*', 'group_*_bot*', '*[bot]']

/** How long a done policy action is remembered (per head commit). */
const POLICY_MEMORY_TTL_SECONDS = 90 * 86_400

/** `PolicyMemory` in the store's key-value part, keys `policy:<engine key>`. */
function kvPolicyMemory(kv: KvStore): PolicyMemory {
  return {
    seen: async (key) => (await kv.get(`policy:${key}`)) !== undefined,
    remember: (key) => kv.set(`policy:${key}`, true, POLICY_MEMORY_TTL_SECONDS),
  }
}

/** The policy event for a merge request hook, or `undefined` for actions policies do not see. */
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

/** The merge request as the forge has it, else as the hook describes it. */
const loadMergeRequest = async (
  forge: GitForge | undefined,
  repo: RepoRef,
  iid: number,
  fallback: () => MergeRequest & { headSha?: string },
): Promise<MergeRequest & { headSha?: string }> => {
  if (forge?.getMergeRequest) {
    try {
      return await forge.getMergeRequest(repo.path, iid)
    } catch {
      // The payload is good enough for most conditions; the engine loads what is missing.
    }
  }
  return fallback()
}

/**
 * Forge webhooks. `POST /webhooks/gitlab` needs `X-Gitlab-Token` equal to `jobs.webhookSecret`
 * and finds the forge by the project URL; `POST /webhooks/<forgeId>` needs the forge's own secret
 * (`jobs.webhooks.<forgeId>.secret`, which panel forges fill from their generated secret).
 *
 * - Tag pushes queue `jobs.onTag.analyzers` with `ref` = the tag.
 * - Merge request events run merge request policies (`mergeRequests.policies`), write every
 *   outcome to the activity log, then queue `jobs.onMergeRequest.analyzers` (open, new commits,
 *   reopen) and `jobs.onLabel[label]` for added labels minus the policies' `skipAnalyzers`, plus
 *   their `enqueue` intents, with `{ mergeRequest: iid }` and `ref` = head sha.
 * - Notes on merge requests: `/holtkeeper <command>` runs policies as a `command` event and queues
 *   `jobs.commands[command]`; a reply in a thread Holtkeeper started queues `review` with
 *   `{ mergeRequest, replyTo: discussionId }`.
 * - Pipeline hooks for a merge request's head that succeeded or failed run policies as `update`,
 *   so deferred approvals and merges happen; only `enqueue` intents are queued.
 *
 * Events by `jobs.botUsername` or carrying Holtkeeper's note marker are ignored.
 */
export function webhookRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const analyzers = new Map((deps.analyzers ?? []).map((analyzer) => [analyzer.kind, analyzer]))
  const app = new Hono<Env>()

  const memory: PolicyMemory = store.kv ? kvPolicyMemory(store.kv) : createMemory()

  const findForge = (webUrl: string | undefined): string | undefined => {
    const gitlabs = configuredGitlabs(config)
    const byUrl = gitlabs.find(
      ([, forge]) => webUrl?.startsWith(`${forge.url.replace(/\/+$/, '')}/`) ?? false,
    )
    return (byUrl ?? (gitlabs.length === 1 ? gitlabs[0] : undefined))?.[0]
  }

  /** Queues the requests, skipping ones already queued or running with the same ref and options. */
  const enqueue = async (requests: JobRequest[], trigger: 'tag' | 'webhook') => {
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

  const activity = (action: string, repo: RepoRef, details: Record<string, unknown>) =>
    store.activity.append({
      at: deps.now().toISOString(),
      actor: 'webhook:gitlab',
      action,
      subject: `${repo.forge}:${repo.path}`,
      details,
    })

  /** Posts a short note; failures do not fail the webhook. */
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
      // The job is queued either way; a missing acknowledgement is not worth a failed delivery.
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
    const botUsername = config.jobs?.botUsername
    return (
      first.body.includes(OWN_MARKER) || (botUsername !== undefined && first.author === botUsername)
    )
  }

  /**
   * Runs the merge request policies that cover the repository and logs every outcome. Without
   * policies nothing is loaded from the forge. Never throws: a failure is logged and treated as
   * "no policy applied".
   */
  const runPolicies = async (
    repo: RepoRef,
    input: Omit<MergeRequestEvent, 'repo' | 'groups' | 'mr' | 'isBot'> & {
      iid: number
      mr: () => MergeRequest & { headSha?: string }
    },
  ): Promise<PolicyEvaluation | undefined> => {
    const target = repoTarget(config, repo)
    const { policies, invalid } = combinePolicies(
      await store.settings.list(policiesSettingKey),
      target,
    )
    for (const problem of invalid) await activity('mr_policy.invalid', repo, { ...problem })
    if (policies.length === 0) return undefined
    const botUser = config.jobs?.botUsername
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

  const repoAnalyzers = (kinds: readonly string[]) =>
    kinds.filter((kind) => analyzers.get(kind)?.scope !== 'group')

  const handle = async (c: AppContext, fixedForge: string | undefined) => {
    const forgeOf = (webUrl: string | undefined) => fixedForge ?? findForge(webUrl)
    const ignore = (reason: string) => c.json<WebhookResult>({ enqueued: [], ignored: reason })
    const accepted = (enqueued: string[]) => c.json<WebhookResult>({ enqueued }, 202)
    const parse = async <T>(schema: z.ZodType<T>): Promise<T> => {
      const parsed = schema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) })
      return parsed.data
    }
    const botUsername = config.jobs?.botUsername
    const fromBot = (user: { username: string } | undefined) =>
      botUsername !== undefined && user?.username === botUsername

    const event = c.req.header('x-gitlab-event') ?? ''

    if (event === 'Tag Push Hook') {
      const hook = await parse(tagPushSchema)
      if (deletedSha.test(hook.after)) return ignore('tag was deleted')

      const onTag = config.jobs?.onTag
      if (!onTag) return ignore('jobs.onTag is not configured')
      const forge = forgeOf(hook.project.web_url)
      if (!forge) return ignore('no configured GitLab forge matches the project')

      const repo: RepoRef = { forge, path: hook.project.path_with_namespace }
      const repoGroups = resolveRepo(config, repo).groups
      const groups = onTag.groups ? repoGroups.filter((g) => onTag.groups?.includes(g)) : repoGroups
      if (onTag.groups && groups.length === 0)
        return ignore('repository is not in jobs.onTag.groups')

      const tag = hook.ref.slice('refs/tags/'.length)
      const requests = onTag.analyzers.flatMap((analyzer): JobRequest[] =>
        analyzers.get(analyzer)?.scope === 'group'
          ? groups.map((group) => ({ analyzer, repo: { forge, path: group }, group }))
          : [{ analyzer, repo, ref: tag }],
      )
      const enqueued = await enqueue(requests, 'tag')
      await activity('job.tag_pushed', repo, { tag, jobs: enqueued })
      return accepted(enqueued)
    }

    if (event === 'Merge Request Hook') {
      const hook = await parse(mergeRequestHookSchema)
      if (fromBot(hook.user)) return ignore('event from the bot user')
      const forge = forgeOf(hook.project.web_url)
      if (!forge) return ignore('no configured GitLab forge matches the project')
      const repo: RepoRef = { forge, path: hook.project.path_with_namespace }
      const mr = hook.object_attributes
      const head = mr.last_commit?.id
      const draft = mr.draft ?? mr.work_in_progress ?? false
      const leftDraftNow =
        hook.changes?.draft?.previous === true && hook.changes.draft.current === false
      const labelsAdded = addedLabels(hook.changes)
      const policyAction = mergeRequestAction(
        mr.action,
        mr.oldrev !== undefined || leftDraftNow,
        labelsAdded,
      )
      const policy = policyAction
        ? await runPolicies(repo, {
            iid: mr.iid,
            action: policyAction,
            actor: hook.user?.username ?? '',
            ...(labelsAdded.length && { labelsAdded }),
            mr: () => ({
              id: mr.iid,
              title: mr.title ?? '',
              description: mr.description ?? '',
              sourceBranch: mr.source_branch ?? '',
              targetBranch: mr.target_branch ?? '',
              state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
              draft,
              labels: (hook.labels ?? hook.changes?.labels?.current ?? []).map((l) => l.title),
              author: '',
              webUrl: mr.url ?? '',
              ...(head && { headSha: head }),
            }),
          })
        : undefined
      if (mr.state === 'closed' || mr.state === 'merged')
        return ignore(`merge request is ${mr.state}`)

      const kinds = new Set<string>()
      const reasons: string[] = []
      const onMergeRequest = config.jobs?.onMergeRequest
      if (onMergeRequest) {
        const leftDraft =
          hook.changes?.draft?.previous === true && hook.changes.draft.current === false
        const action =
          mr.action === 'open' || mr.action === 'reopen'
            ? mr.action
            : mr.action === 'update' && (mr.oldrev !== undefined || leftDraft)
              ? 'update'
              : undefined
        const actions = onMergeRequest.actions ?? ['open', 'update', 'reopen']
        const groups = resolveRepo(config, repo).groups
        if (!action) reasons.push(`action ${mr.action ?? '(none)'} brings no new commits`)
        else if (!actions.includes(action)) reasons.push(`action ${action} is not configured`)
        else if (draft && !onMergeRequest.draft) reasons.push('merge request is a draft')
        else if (onMergeRequest.groups && !groups.some((g) => onMergeRequest.groups?.includes(g)))
          reasons.push('repository is not in jobs.onMergeRequest.groups')
        else for (const kind of repoAnalyzers(onMergeRequest.analyzers)) kinds.add(kind)
      }
      const labels = labelsAdded
      for (const label of labels)
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
          options: { ...options, mergeRequest: mr.iid },
        })),
        'webhook',
      )
      await activity('job.merge_request', repo, {
        mergeRequest: mr.iid,
        action: mr.action,
        labels,
        jobs: enqueued,
      })
      return accepted(enqueued)
    }

    if (event === 'Note Hook') {
      const hook = await parse(noteHookSchema)
      const note = hook.object_attributes
      const mr = hook.merge_request
      if (note.noteable_type !== 'MergeRequest' || !mr)
        return ignore('note is not on a merge request')
      if (fromBot(hook.user) || note.note.includes(OWN_MARKER))
        return ignore('event from the bot user')
      const forge = forgeOf(hook.project.web_url)
      if (!forge) return ignore('no configured GitLab forge matches the project')
      const repo: RepoRef = { forge, path: hook.project.path_with_namespace }
      const head = mr.last_commit?.id
      const request = (analyzer: string, options: Record<string, unknown>): JobRequest => ({
        analyzer,
        repo,
        ...(head ? { ref: head } : {}),
        options: { mergeRequest: mr.iid, ...options },
      })

      const command = parseCommand(note.note)
      if (command) {
        const policy = await runPolicies(repo, {
          iid: mr.iid,
          action: 'command',
          command: command.name,
          actor: hook.user?.username ?? '',
          mr: () => ({
            id: mr.iid,
            title: '',
            description: '',
            sourceBranch: '',
            targetBranch: '',
            state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
            draft: false,
            labels: [],
            author: '',
            webUrl: '',
            ...(head && { headSha: head }),
          }),
        })
        const intents = withPolicies([], policy)
        const fromPolicies = intents.length
          ? await enqueue(
              intents.map(({ analyzer, options }) => request(analyzer, options ?? {})),
              'webhook',
            )
          : []
        const commands = config.jobs?.commands
        const definition = commands?.[command.name]
        if (!definition && policy?.matched.length) return accepted(fromPolicies)
        if (!commands) return ignore('jobs.commands is not configured')
        if (!definition) {
          const available = Object.keys(commands)
            .map((name) => `\`${name}\``)
            .join(', ')
          await acknowledge(
            repo,
            mr.iid,
            note.discussion_id,
            `Unknown command \`${command.name}\`. Available: ${available}.`,
          )
          return ignore(`unknown command ${command.name}`)
        }
        const job = request(definition.analyzer, commandOptions(command.args, definition.args))
        const checked = analyzers.get(definition.analyzer)?.options.safeParse(job.options)
        if (checked && !checked.success) {
          await acknowledge(
            repo,
            mr.iid,
            note.discussion_id,
            `Could not run \`${command.name}\`:\n\n${z.prettifyError(checked.error)}`,
          )
          return ignore('invalid command options')
        }
        const skip = policy?.skipAnalyzers ?? []
        const enqueued =
          skip === '*' || skip.includes(job.analyzer)
            ? fromPolicies
            : [...fromPolicies, ...(await enqueue([job], 'webhook'))]
        await acknowledge(
          repo,
          mr.iid,
          note.discussion_id,
          enqueued.length
            ? `Queued \`${command.name}\` (job ${enqueued.join(', ')}).`
            : `\`${command.name}\` is already queued for this commit.`,
        )
        await activity('job.command', repo, {
          mergeRequest: mr.iid,
          command: command.name,
          ...(hook.user ? { author: hook.user.username } : {}),
          jobs: enqueued,
        })
        return accepted(enqueued)
      }

      const discussionId = note.discussion_id
      if (!discussionId || (note.type !== 'DiffNote' && note.type !== 'DiscussionNote'))
        return ignore('note is not a reply in a thread')
      if (!(await isOurThread(repo, mr.iid, discussionId)))
        return ignore('thread was not started by Holtkeeper')
      const analyzer = config.jobs?.commands?.review?.analyzer ?? 'review'
      const enqueued = await enqueue([request(analyzer, { replyTo: discussionId })], 'webhook')
      await activity('job.thread_reply', repo, {
        mergeRequest: mr.iid,
        discussionId,
        jobs: enqueued,
      })
      return accepted(enqueued)
    }

    if (event === 'Pipeline Hook') {
      const hook = await parse(pipelineHookSchema)
      const pipeline = hook.object_attributes
      const iid = hook.merge_request?.iid
      if (!iid) return ignore('pipeline is not for a merge request')
      if (pipeline.status !== 'success' && pipeline.status !== 'failed')
        return ignore(`pipeline is ${pipeline.status}`)
      const forge = forgeOf(hook.project.web_url)
      if (!forge) return ignore('no configured GitLab forge matches the project')
      const repo: RepoRef = { forge, path: hook.project.path_with_namespace }
      const client = config.forges[forge]?.create()
      if (client?.getMergeRequest) {
        try {
          const current = await client.getMergeRequest(repo.path, iid)
          if (current.headSha && current.headSha !== pipeline.sha)
            return ignore('pipeline is not for the merge request head')
        } catch {
          // Evaluate anyway; the engine checks the head itself.
        }
      }
      const policy = await runPolicies(repo, {
        iid,
        action: 'update',
        actor: hook.user?.username ?? '',
        mr: () => ({
          id: iid,
          title: '',
          description: '',
          sourceBranch: '',
          targetBranch: '',
          state: 'open',
          draft: false,
          labels: [],
          author: '',
          webUrl: '',
          headSha: pipeline.sha,
        }),
      })
      const intents = withPolicies([], policy)
      if (!intents.length) return ignore(policy ? 'policies queued nothing' : 'no policies apply')
      const enqueued = await enqueue(
        intents.map(({ analyzer, options }) => ({
          analyzer,
          repo,
          ref: pipeline.sha,
          options: { ...options, mergeRequest: iid },
        })),
        'webhook',
      )
      return accepted(enqueued)
    }

    return ignore(`event ${event || '(none)'} is not handled`)
  }

  app.post('/webhooks/gitlab', async (c) => {
    const secret = config.jobs?.webhookSecret
    if (!secret) throw new HTTPException(404, { message: 'webhooks are not enabled' })
    if (!sameSecret(c.req.header('x-gitlab-token') ?? '', resolveSecret(secret)))
      throw new HTTPException(401, { message: 'invalid webhook token' })
    return handle(c, undefined)
  })

  app.post('/webhooks/:forge', async (c) => {
    const forgeId = c.req.param('forge')
    const secret = config.jobs?.webhooks?.[forgeId]?.secret
    const forge = config.forges[forgeId]
    if (!secret || !forge)
      throw new HTTPException(404, { message: `no webhook for forge ${forgeId}` })
    if (forge.kind !== 'gitlab')
      throw new HTTPException(404, {
        message: `webhooks of ${forge.kind} forges are not supported yet`,
      })
    if (!sameSecret(c.req.header('x-gitlab-token') ?? '', resolveSecret(secret)))
      throw new HTTPException(401, { message: 'invalid webhook token' })
    return handle(c, forgeId)
  })

  return app
}
