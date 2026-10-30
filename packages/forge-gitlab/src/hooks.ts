import type {
  GitForge,
  RegisteredHook,
  WebhookEvent,
  WebhookSpec,
  WebhookTarget,
} from '@holtkeeper/forge'
import { z } from 'zod'

import { encode, GitLabApiError, type GitLabClient } from './http.ts'

const hookSchema = z.object({ id: z.number(), url: z.string() })
const projectSchema = z.object({
  path_with_namespace: z.string(),
  archived: z.boolean().optional(),
})

const EVENT_FIELDS: [WebhookEvent, string][] = [
  ['push', 'push_events'],
  ['tag_push', 'tag_push_events'],
  ['merge_request', 'merge_requests_events'],
  ['note', 'note_events'],
  ['pipeline', 'pipeline_events'],
]

/** GitLab's hook body: every known event switched on or off explicitly. */
export function hookBody(hook: WebhookSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    url: hook.url,
    token: hook.secret,
    enable_ssl_verification: true,
  }
  for (const [event, field] of EVENT_FIELDS) body[field] = hook.events.includes(event)
  return body
}

const base = (scope: 'group' | 'project', target: string) =>
  `${scope === 'group' ? 'groups' : 'projects'}/${encode(target)}/hooks`

// Group hooks need Premium; Free answers 404, and some versions 403.
const groupHooksUnavailable = (error: unknown) =>
  error instanceof GitLabApiError && (error.status === 404 || error.status === 403)

/**
 * Group and project webhooks over GitLab REST v4, idempotent by URL. A group target uses a group
 * hook; when GitLab refuses group hooks, it falls back to one project hook per non-archived
 * project of the group (subgroups included) and reports that in `fallback`.
 */
export function gitlabHooks(
  client: GitLabClient,
): Pick<GitForge, 'ensureWebhook' | 'removeWebhook'> {
  const ensureOn = async (
    scope: 'group' | 'project',
    target: string,
    hook: WebhookSpec,
  ): Promise<RegisteredHook> => {
    const path = base(scope, target)
    const existing = (await collect(client.paginate(path, hookSchema))).find(
      (candidate) => candidate.url === hook.url,
    )
    const saved = existing
      ? await client.json('PUT', `${path}/${existing.id}`, hookSchema, { body: hookBody(hook) })
      : await client.json('POST', path, hookSchema, { body: hookBody(hook) })
    return { id: String(saved.id), scope, target }
  }

  return {
    async ensureWebhook(target: WebhookTarget, hook: WebhookSpec) {
      if (target.project) {
        const registered = await ensureOn('project', target.project, hook)
        return { id: registered.id, hooks: [registered] }
      }
      const group = target.group
      if (!group) throw new Error('ensureWebhook needs a group or a project')
      try {
        const registered = await ensureOn('group', group, hook)
        return { id: registered.id, hooks: [registered] }
      } catch (error) {
        if (!groupHooksUnavailable(error)) throw error
      }
      const projects = await collect(
        client.paginate(`groups/${encode(group)}/projects`, projectSchema, {
          include_subgroups: true,
          archived: false,
          order_by: 'id',
          sort: 'asc',
        }),
      )
      const hooks: RegisteredHook[] = []
      for (const project of projects) {
        if (project.archived) continue
        // oxlint-disable-next-line no-await-in-loop -- sequential keeps us under rate limits
        hooks.push(await ensureOn('project', project.path_with_namespace, hook))
      }
      return {
        id: hooks[0]?.id ?? '',
        hooks,
        fallback: `group hooks are not available for ${group}; registered ${hooks.length} project hook(s) instead`,
      }
    },

    async removeWebhook(hooks: RegisteredHook[]) {
      for (const hook of hooks) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await client.text('DELETE', `${base(hook.scope, hook.target)}/${encode(hook.id)}`)
        } catch (error) {
          if (!(error instanceof GitLabApiError && error.status === 404)) throw error
        }
      }
    },
  }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}
