import { createHash, timingSafeEqual } from 'node:crypto'

import type { HoltkeeperConfig } from '@holtkeeper/core'
import {
  type ForgeEvent,
  type PipelineStatus,
  type RepoRef,
  resolveSecret,
} from '@holtkeeper/forge'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import type { AppContext, Env, ServerDeps } from '../context.ts'
import { type EventDispatcher, type EventOutcome, createEventDispatcher } from '../events.ts'
import type { RepoHooks } from '../repo-hooks.ts'
import { markWebhookSeen } from '../updates.ts'

const projectSchema = z.object({
  path_with_namespace: z.string().min(1),
  web_url: z.string().optional(),
  default_branch: z.string().optional(),
})
const userSchema = z.object({ username: z.string() }).optional()

const tagPushSchema = z.object({
  object_kind: z.literal('tag_push'),
  ref: z.string().startsWith('refs/tags/'),
  after: z.string(),
  project: projectSchema,
})

/** GitLab "Push Hook" payload, the fields used here. */
const pushSchema = z.object({
  object_kind: z.literal('push'),
  ref: z.string(),
  before: z.string().optional(),
  after: z.string(),
  user_username: z.string().optional(),
  project: projectSchema,
  commits: z
    .array(
      z.object({
        added: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  total_commits_count: z.number().optional(),
})

/** Paths a push hook's commits touched, when the hook lists every commit (GitLab sends at most 20). */
const pushedFiles = (hook: z.infer<typeof pushSchema>) => {
  const commits = hook.commits
  if (!commits || (hook.total_commits_count ?? commits.length) > commits.length) return undefined
  return [
    ...new Set(
      commits.flatMap((commit) => [
        ...(commit.added ?? []),
        ...(commit.modified ?? []),
        ...(commit.removed ?? []),
      ]),
    ),
  ]
}

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

const mrState = (state: string | undefined) =>
  state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open'

const addedLabels = (changes: z.infer<typeof mergeRequestHookSchema>['changes']) => {
  if (!changes?.labels) return []
  const before = new Set(changes.labels.previous.map((l) => l.title))
  return changes.labels.current.map((l) => l.title).filter((title) => !before.has(title))
}

const configuredGitlabs = (config: HoltkeeperConfig) =>
  Object.entries(config.forges).filter(([, forge]) => forge.kind === 'gitlab')

/** A GitLab delivery as a forge event, or why it carries none. */
type Parsed = { event: ForgeEvent } | { ignored: string }

/**
 * Reads a GitLab webhook delivery. `forgeOf` finds the forge id by the project URL; `undefined`
 * ignores the delivery. Invalid payloads of handled events are a 400.
 */
async function parseGitlab(
  c: AppContext,
  forgeOf: (webUrl: string | undefined) => string | undefined,
): Promise<Parsed> {
  const parse = async <T>(schema: z.ZodType<T>): Promise<T> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) })
    return parsed.data
  }
  const noForge = { ignored: 'no configured GitLab forge matches the project' }
  const repoOf = (project: z.infer<typeof projectSchema>): RepoRef | undefined => {
    const forge = forgeOf(project.web_url)
    return forge ? { forge, path: project.path_with_namespace } : undefined
  }
  const header = c.req.header('x-gitlab-event') ?? ''

  if (header === 'Tag Push Hook') {
    const hook = await parse(tagPushSchema)
    if (deletedSha.test(hook.after)) return { ignored: 'tag was deleted' }
    const repo = repoOf(hook.project)
    if (!repo) return noForge
    return {
      event: { kind: 'tag', repo, tag: hook.ref.slice('refs/tags/'.length), sha: hook.after },
    }
  }

  if (header === 'Push Hook') {
    const hook = await parse(pushSchema)
    if (!hook.ref.startsWith('refs/heads/')) return { ignored: 'push is not to a branch' }
    if (deletedSha.test(hook.after)) return { ignored: 'branch was deleted' }
    const repo = repoOf(hook.project)
    if (!repo) return noForge
    const files = pushedFiles(hook)
    return {
      event: {
        kind: 'push',
        repo,
        branch: hook.ref.slice('refs/heads/'.length),
        sha: hook.after,
        actor: hook.user_username ?? '',
        ...(hook.before && !deletedSha.test(hook.before) ? { before: hook.before } : {}),
        ...(files ? { files } : {}),
        ...(hook.project.default_branch ? { defaultBranch: hook.project.default_branch } : {}),
      },
    }
  }

  if (header === 'Merge Request Hook') {
    const hook = await parse(mergeRequestHookSchema)
    const repo = repoOf(hook.project)
    if (!repo) return noForge
    const mr = hook.object_attributes
    const head = mr.last_commit?.id
    return {
      event: {
        kind: 'mergeRequest',
        repo,
        action: mr.action ?? '',
        actor: hook.user?.username ?? '',
        newCommits: mr.oldrev !== undefined,
        leftDraft: hook.changes?.draft?.previous === true && hook.changes.draft.current === false,
        labelsAdded: addedLabels(hook.changes),
        mr: {
          id: mr.iid,
          title: mr.title ?? '',
          description: mr.description ?? '',
          sourceBranch: mr.source_branch ?? '',
          targetBranch: mr.target_branch ?? '',
          state: mrState(mr.state),
          draft: mr.draft ?? mr.work_in_progress ?? false,
          labels: (hook.labels ?? hook.changes?.labels?.current ?? []).map((l) => l.title),
          author: '',
          webUrl: mr.url ?? '',
          ...(head && { headSha: head }),
        },
      },
    }
  }

  if (header === 'Note Hook') {
    const hook = await parse(noteHookSchema)
    const note = hook.object_attributes
    const mr = hook.merge_request
    if (note.noteable_type !== 'MergeRequest' || !mr)
      return { ignored: 'note is not on a merge request' }
    const repo = repoOf(hook.project)
    if (!repo) return noForge
    const head = mr.last_commit?.id
    return {
      event: {
        kind: 'note',
        repo,
        mergeRequest: mr.iid,
        mergeRequestState: mrState(mr.state),
        ...(head && { headSha: head }),
        author: hook.user?.username ?? '',
        body: note.note,
        ...(note.discussion_id && { discussionId: note.discussion_id }),
        inThread: note.type === 'DiffNote' || note.type === 'DiscussionNote',
      },
    }
  }

  if (header === 'Pipeline Hook') {
    const hook = await parse(pipelineHookSchema)
    const pipeline = hook.object_attributes
    const iid = hook.merge_request?.iid
    if (!iid) return { ignored: 'pipeline is not for a merge request' }
    if (pipeline.status !== 'success' && pipeline.status !== 'failed')
      return { ignored: `pipeline is ${pipeline.status}` }
    const repo = repoOf(hook.project)
    if (!repo) return noForge
    return {
      event: {
        kind: 'pipeline',
        repo,
        mergeRequest: iid,
        pipelineId: pipeline.id,
        status: pipeline.status as PipelineStatus,
        sha: pipeline.sha,
        actor: hook.user?.username ?? '',
      },
    }
  }

  return { ignored: `event ${header || '(none)'} is not handled` }
}

export interface WebhookRoutesOptions {
  dispatch?: EventDispatcher
  /** Per-repository webhook tokens; `POST /webhooks/r/<token>` answers 404 without them. */
  repoHooks?: RepoHooks
}

/**
 * Forge webhooks, turned into forge events for the event dispatcher (see `createEventDispatcher`).
 *
 * - `POST /webhooks/gitlab` needs `X-Gitlab-Token` equal to `jobs.webhookSecret` and finds the
 *   forge by the project URL.
 * - `POST /webhooks/<forgeId>` needs the forge's own secret (`jobs.webhooks.<forgeId>.secret`,
 *   which panel forges fill from their generated secret).
 * - `POST /webhooks/r/<token>` is one repository's webhook: the token in the URL is the secret,
 *   and deliveries about another project are refused with 403.
 *
 * Every delivery about a repository marks it as reached by webhooks, which slows its polling down.
 */
export function webhookRoutes(deps: ServerDeps, options: WebhookRoutesOptions = {}) {
  const { config, store } = deps
  const dispatch = options.dispatch ?? createEventDispatcher(deps)
  const app = new Hono<Env>()

  const findForge = (webUrl: string | undefined): string | undefined => {
    const gitlabs = configuredGitlabs(config)
    const byUrl = gitlabs.find(
      ([, forge]) => webUrl?.startsWith(`${forge.url.replace(/\/+$/, '')}/`) ?? false,
    )
    return (byUrl ?? (gitlabs.length === 1 ? gitlabs[0] : undefined))?.[0]
  }

  const handle = async (
    c: AppContext,
    forgeOf: (webUrl: string | undefined) => string | undefined,
    check?: (repo: RepoRef) => void,
  ): Promise<{ response: Response; repo?: RepoRef; outcome: EventOutcome }> => {
    const parsed = await parseGitlab(c, forgeOf)
    if ('ignored' in parsed) {
      const outcome = { enqueued: [], ignored: parsed.ignored }
      return { response: c.json<EventOutcome>(outcome), outcome }
    }
    const { repo } = parsed.event
    check?.(repo)
    if (store.kv) await markWebhookSeen(store.kv, repo, deps.now())
    const outcome = await dispatch(parsed.event, { actor: 'webhook:gitlab', via: 'webhook' })
    return {
      response: outcome.ignored ? c.json(outcome) : c.json(outcome, 202),
      repo,
      outcome,
    }
  }

  app.post('/webhooks/gitlab', async (c) => {
    const secret = config.jobs?.webhookSecret
    if (!secret) throw new HTTPException(404, { message: 'webhooks are not enabled' })
    if (!sameSecret(c.req.header('x-gitlab-token') ?? '', resolveSecret(secret)))
      throw new HTTPException(401, { message: 'invalid webhook token' })
    return (await handle(c, findForge)).response
  })

  app.post('/webhooks/r/:token', async (c) => {
    const hooks = options.repoHooks
    const repo = hooks ? await hooks.find(c.req.param('token')) : undefined
    if (!hooks || !repo) throw new HTTPException(404, { message: 'unknown webhook' })
    const forge = config.forges[repo.forge]
    if (!forge) throw new HTTPException(404, { message: `forge ${repo.forge} is not configured` })
    if (forge.kind !== 'gitlab')
      throw new HTTPException(404, {
        message: `webhooks of ${forge.kind} forges are not supported yet`,
      })
    const { response, outcome } = await handle(
      c,
      () => repo.forge,
      (about) => {
        if (about.path.toLowerCase() !== repo.path.toLowerCase())
          throw new HTTPException(403, { message: 'this webhook belongs to another repository' })
      },
    )
    await hooks.recordDelivery(repo, {
      at: deps.now().toISOString(),
      event: c.req.header('x-gitlab-event') ?? '',
      enqueued: outcome.enqueued.length,
      ...(outcome.ignored !== undefined && { ignored: outcome.ignored }),
    })
    return response
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
    return (await handle(c, () => forgeId)).response
  })

  return app
}
