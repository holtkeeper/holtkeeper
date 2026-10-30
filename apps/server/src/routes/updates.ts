import type {
  GroupListingView,
  RepoPollResult,
  RepoUpdatesView,
  RepoWebhookInput,
} from '@holtkeeper/api'
import type { RepoRef, WebhookEvent } from '@holtkeeper/forge'
import type { RegisteredWebhook } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  publicUrlOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { type RepoHook, type RepoHooks, repoHookPath } from '../repo-hooks.ts'
import type { Poller } from '../updates.ts'

/** Events a repository webhook registered by Holtkeeper delivers. */
const WEBHOOK_EVENTS: WebhookEvent[] = ['tag_push', 'merge_request', 'note', 'pipeline']

const webhookInputSchema = z.object({ repo: z.string().min(1), register: z.boolean().optional() })
const pollInputSchema = z.object({ repo: z.string().min(1) })

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface UpdateRoutesOptions {
  poller?: Poller
  repoHooks?: RepoHooks
}

/**
 * How a repository learns about forge changes: `GET /repos/updates?repo=` shows its polling and
 * webhook state, `POST /repos/updates/poll` polls it now, `POST /repos/updates/webhook` issues or
 * rotates its webhook URL (optionally registering it on the forge) and `DELETE
 * /repos/updates/webhook?repo=` turns the URL off and removes hooks Holtkeeper registered.
 * `GET /repos/updates/groups/:group` shows the repositories polling knows for a group and its
 * recent listings; `POST /repos/updates/groups/:group/list` lists them on the forge now.
 * Reading needs `settings:read` on the repository (or group), the rest `settings:write`; the webhook URL is
 * only shown to callers with `settings:write`. All answer 503 without a key-value store.
 */
export function updateRoutes(deps: ServerDeps, options: UpdateRoutesOptions) {
  const app = new Hono<Env>()

  const parts = () => {
    if (!options.poller || !options.repoHooks)
      throw new HTTPException(503, {
        message: 'polling and repository webhooks need a key-value store',
      })
    return { poller: options.poller, hooks: options.repoHooks }
  }

  const repoOf = (value: string | undefined): RepoRef => {
    const repo = parseRepo(value)
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    if (!(repo.forge in deps.config.forges))
      throw new HTTPException(404, { message: `forge ${repo.forge} is not configured` })
    return repo
  }

  const target = (repo: RepoRef) => ({ kind: 'repo' as const, repo: repoTarget(deps.config, repo) })

  const view = async (c: AppContext, repo: RepoRef, withUrl: boolean): Promise<RepoUpdatesView> => {
    const { poller, hooks } = parts()
    const status = await poller.status(repo)
    const hook = await hooks.get(repo)
    const { config, state } = status
    const forge = deps.config.forges[repo.forge]
    return {
      repo,
      polling: {
        enabled: config.enabled,
        intervalMs: config.intervalMs,
        events: config.events,
        ...(config.withWebhookMs !== undefined && { withWebhookMs: config.withWebhookMs }),
        ...(state.intervalMs !== undefined && { effectiveIntervalMs: state.intervalMs }),
        ...(state.stretch !== undefined && { stretch: state.stretch }),
        key: status.key,
        ...(state.lastPolledAt && { lastPolledAt: state.lastPolledAt }),
        ...(state.nextAt && config.enabled && { nextAt: state.nextAt }),
        ...(state.lastError && { lastError: state.lastError }),
        ...(state.lastEvents !== undefined && { lastEvents: state.lastEvents }),
        ...(state.lastRequests !== undefined && { lastRequests: state.lastRequests }),
        attempts: state.attempts ?? [],
      },
      ...(status.webhookSeenAt && { webhookSeenAt: status.webhookSeenAt }),
      viaWebhook: status.viaWebhook,
      ...(hook && {
        webhook: {
          ...(withUrl && {
            url: `${publicUrlOf(deps, c)}${repoHookPath(await hooks.token(hook))}`,
          }),
          createdAt: hook.createdAt,
          ...(hook.registered?.length && { registered: hook.registered }),
          ...(hook.lastDelivery && { lastDelivery: hook.lastDelivery }),
        },
      }),
      canRegister: forge?.kind === 'gitlab',
    }
  }

  const canWrite = (c: AppContext, repo: RepoRef) => {
    try {
      authorize(c, 'settings:write', target(repo))
      return true
    } catch {
      return false
    }
  }

  const unregister = async (repo: RepoRef, hook: RepoHook | undefined) => {
    if (!hook?.registered?.length) return undefined
    try {
      await deps.config.forges[repo.forge]
        ?.create()
        .removeWebhook?.(
          hook.registered.map((h) => ({ id: h.hookId, scope: h.scope, target: h.target })),
        )
      return undefined
    } catch (error) {
      return messageOf(error)
    }
  }

  const activity = (
    actor: string,
    action: string,
    repo: RepoRef,
    details: Record<string, unknown>,
  ) =>
    deps.store.activity.append({
      at: deps.now().toISOString(),
      actor,
      action,
      subject: `${repo.forge}:${repo.path}`,
      details,
    })

  app.get('/repos/updates', async (c) => {
    const repo = repoOf(c.req.query('repo'))
    authorize(c, 'settings:read', target(repo))
    return c.json<RepoUpdatesView>(await view(c, repo, canWrite(c, repo)))
  })

  const groupOf = (c: AppContext, action: 'settings:read' | 'settings:write') => {
    const group = c.req.param('group') ?? ''
    const definition = deps.config.groups[group]
    if (!definition) throw new HTTPException(404, { message: `group ${group} is not configured` })
    authorize(c, action, { kind: 'scope', scope: { groups: [group] } })
    return { group, forge: definition.forge }
  }

  const listingView = async (group: string, forge: string): Promise<GroupListingView> => {
    const listing = await parts().poller.listing(group)
    return {
      group,
      forge,
      repos: listing?.repos ?? [],
      ...(listing?.listedAt && { listedAt: listing.listedAt }),
      attempts: listing?.attempts ?? [],
    }
  }

  app.get('/repos/updates/groups/:group', async (c) => {
    const { group, forge } = groupOf(c, 'settings:read')
    return c.json<GroupListingView>(await listingView(group, forge))
  })

  app.post('/repos/updates/groups/:group/list', async (c) => {
    const { group, forge } = groupOf(c, 'settings:write')
    await parts().poller.listGroup(group)
    return c.json<GroupListingView>(await listingView(group, forge))
  })

  app.post('/repos/updates/poll', async (c) => {
    const input = await readBody(c, pollInputSchema)
    const repo = repoOf(input.repo)
    authorize(c, 'settings:write', target(repo))
    return c.json<RepoPollResult>(await parts().poller.pollNow(repo))
  })

  app.post('/repos/updates/webhook', async (c) => {
    const input: RepoWebhookInput = await readBody(c, webhookInputSchema)
    const repo = repoOf(input.repo)
    const principal = authorize(c, 'settings:write', target(repo))
    const { hooks } = parts()
    const { token, hook, previous } = await hooks.rotate(
      repo,
      deps.now().toISOString(),
      principal.id,
    )
    const url = `${publicUrlOf(deps, c)}${repoHookPath(token)}`
    const register = input.register ?? (previous?.registered?.length ?? 0) > 0
    const details: Record<string, unknown> = { register }

    if (register) {
      const forge = deps.config.forges[repo.forge]?.create()
      if (!forge?.ensureWebhook)
        throw new HTTPException(409, { message: `forge ${repo.forge} cannot register webhooks` })
      const removeError = await unregister(repo, previous)
      if (removeError) details.removeError = removeError
      let registered: RegisteredWebhook[] = []
      try {
        const registration = await forge.ensureWebhook(
          { project: repo.path },
          { url, secret: token, events: WEBHOOK_EVENTS },
        )
        registered = registration.hooks.map((h) => ({
          hookId: h.id,
          scope: h.scope,
          target: h.target,
          url,
        }))
      } catch (error) {
        details.error = messageOf(error)
      }
      const { registered: _old, ...rest } = hook
      await hooks.save(repo, registered.length ? { ...rest, registered } : rest)
    }

    await activity(
      principal.id,
      previous ? 'repo.webhook_rotated' : 'repo.webhook_created',
      repo,
      details,
    )
    if (typeof details.error === 'string')
      throw new HTTPException(502, {
        message: `the new URL is active but registering it on the forge failed: ${details.error}`,
      })
    return c.json<RepoUpdatesView>(await view(c, repo, true), 201)
  })

  app.delete('/repos/updates/webhook', async (c) => {
    const repo = repoOf(c.req.query('repo'))
    const principal = authorize(c, 'settings:write', target(repo))
    const { hooks } = parts()
    const hook = await hooks.remove(repo)
    if (!hook) throw new HTTPException(404, { message: 'the repository has no webhook' })
    const removeError = await unregister(repo, hook)
    await activity(principal.id, 'repo.webhook_removed', repo, {
      ...(removeError && { removeError }),
    })
    return c.body(null, 204)
  })

  return app
}
