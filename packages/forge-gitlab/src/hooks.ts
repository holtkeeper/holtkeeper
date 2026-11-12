import type {
  GitForge,
  RegisteredHook,
  WebhookEvent,
  WebhookSpec,
  WebhookStatus,
  WebhookTarget,
} from '@holtkeeper/forge'
import { z } from 'zod'

import { encode, GitLabApiError, type GitLabClient } from './http.ts'

const hookSchema = z.object({ id: z.number(), url: z.string() })
const hookStatusSchema = hookSchema.extend({
  alert_status: z.string().nullish(),
  disabled_until: z.string().nullish(),
})
const projectSchema = z.object({
  path_with_namespace: z.string(),
  archived: z.boolean().optional(),
})

const EVENT_FIELDS: Record<WebhookEvent, string> = {
  push: 'push_events',
  tag_push: 'tag_push_events',
  merge_request: 'merge_requests_events',
  note: 'note_events',
  confidential_note: 'confidential_note_events',
  issues: 'issues_events',
  confidential_issues: 'confidential_issues_events',
  pipeline: 'pipeline_events',
  job: 'job_events',
  deployment: 'deployment_events',
  releases: 'releases_events',
  wiki_page: 'wiki_page_events',
  milestone: 'milestone_events',
  member: 'member_events',
  emoji: 'emoji_events',
  feature_flag: 'feature_flag_events',
  resource_access_token: 'resource_access_token_events',
}

/** GitLab's hook body: every known event switched on or off explicitly. */
export function hookBody(hook: WebhookSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    url: hook.url,
    token: hook.secret,
    enable_ssl_verification: true,
  }
  for (const [event, field] of Object.entries(EVENT_FIELDS))
    body[field] = hook.events.some((wanted) => wanted === event)
  return body
}

const base = (scope: 'group' | 'project', target: string) =>
  `${scope === 'group' ? 'groups' : 'projects'}/${encode(target)}/hooks`

// Group hooks need Premium; Free answers 404, and some versions 403.
const groupHooksUnavailable = (error: unknown) =>
  error instanceof GitLabApiError && (error.status === 404 || error.status === 403)

// GitLab builds these test payloads without project content and Holtkeeper ignores their events;
// push_events, built from real commits, is the last resort.
const TEST_TRIGGERS = ['resource_access_token_events', 'releases_events', 'push_events'] as const

// 400: the trigger is unknown to this GitLab version; 422 "Ensure the project has ...": no data.
const cannotBuild = (error: unknown) =>
  error instanceof GitLabApiError &&
  (error.status === 400 || (error.status === 422 && /\bensure\b/i.test(error.message)))

const notFound = (error: unknown) => error instanceof GitLabApiError && error.status === 404

// alert_status exists since GitLab 17.x; older versions only set disabled_until.
function hookStatusOf(hook: z.infer<typeof hookStatusSchema>): WebhookStatus {
  const id = String(hook.id)
  const until = hook.disabled_until ?? undefined
  if (hook.alert_status === 'disabled') return { state: 'disabled', id }
  if (
    hook.alert_status === 'temporarily_disabled' ||
    (!hook.alert_status && until !== undefined && Date.parse(until) > Date.now())
  )
    return {
      state: 'temporarily_disabled',
      id,
      ...(until !== undefined && { disabledUntil: until }),
    }
  return { state: 'enabled', id }
}

/**
 * Group and project webhooks over GitLab REST v4, idempotent by URL. A group target uses a group
 * hook; when GitLab refuses group hooks, it falls back to one project hook per non-archived
 * project of the group (subgroups included) and reports that in `fallback`. `webhookStatus` reads
 * `alert_status` and `disabled_until`; `enableWebhook` sends a test delivery, which GitLab answers
 * by re-enabling the hook when it succeeds (422 when it does not). It tries a resource access token
 * event, then a release event, both of which Holtkeeper's receiver ignores, and sends a test push
 * (built from the project's last commits) only when GitLab cannot build either.
 */
export function gitlabHooks(
  client: GitLabClient,
): Pick<GitForge, 'ensureWebhook' | 'removeWebhook' | 'webhookStatus' | 'enableWebhook'> {
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
          if (!notFound(error)) throw error
        }
      }
    },

    async webhookStatus(hook: RegisteredHook, url: string) {
      const path = base(hook.scope, hook.target)
      let found: z.infer<typeof hookStatusSchema> | undefined
      try {
        found = await client.json('GET', `${path}/${encode(hook.id)}`, hookStatusSchema)
      } catch (error) {
        if (!notFound(error)) throw error
      }
      if (found?.url !== url)
        found = (await collect(client.paginate(path, hookStatusSchema))).find(
          (candidate) => candidate.url === url,
        )
      return found ? hookStatusOf(found) : { state: 'missing' as const }
    },

    async enableWebhook(hook: RegisteredHook) {
      const path = `${base(hook.scope, hook.target)}/${encode(hook.id)}/test`
      for (const [index, trigger] of TEST_TRIGGERS.entries()) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one test delivery at a time
          await client.text('POST', `${path}/${trigger}`)
          return
        } catch (error) {
          if (index === TEST_TRIGGERS.length - 1 || !cannotBuild(error)) throw error
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
