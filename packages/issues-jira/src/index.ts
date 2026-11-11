import type { Issue, IssueCategory, IssueTracker } from '@holtkeeper/issues'
import { z } from 'zod'

/** The subset of `fetch` the client uses; the global `fetch` satisfies it. */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Options of `jiraTracker`. */
export interface JiraOptions {
  /** Cloud `https://<site>.atlassian.net`, or the Data Center base URL with its context path. */
  url: string
  auth: { kind: 'basic'; email: string; token: string } | { kind: 'bearer'; token: string }
  /** Default `cloud` for `*.atlassian.net` and `api.atlassian.com`, `datacenter` otherwise. */
  flavor?: 'cloud' | 'datacenter'
  /** Project keys (`ABC`) whose issues may be read; other keys are never sent. Default: any. */
  projects?: readonly string[]
  fetch?: FetchLike
}

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/u
const BATCH = 100
const SINGLE_CONCURRENCY = 5

const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().nullish(),
    status: z
      .object({
        name: z.string().optional(),
        statusCategory: z.object({ key: z.string().optional() }).optional(),
      })
      .nullish(),
    issuetype: z.object({ name: z.string().optional() }).nullish(),
  }),
})

const searchSchema = z.object({ issues: z.array(issueSchema) })

const categories: Record<string, IssueCategory> = {
  new: 'todo',
  indeterminate: 'doing',
  done: 'done',
}

/** A Jira request that failed; the message carries the status and never the credentials. */
export class JiraApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const failed = (what: string, status: number) =>
  new JiraApiError(status, `Jira ${what} failed with ${status}`)

const isCloud = (url: URL) =>
  url.hostname.endsWith('.atlassian.net') || url.hostname === 'api.atlassian.com'

/**
 * A read-only `IssueTracker` for one Jira site: up to 100 keys per search (`key in (...)`), and
 * when Jira refuses the search because a key does not exist, one request per key with unknown
 * ones left out. Keys that do not look like Jira keys, or belong to a project outside
 * `projects`, are never sent. Requests never follow
 * redirects, so the credentials stay on the configured host.
 */
export function jiraTracker(options: JiraOptions): IssueTracker {
  const base = new URL(options.url.replace(/\/+$/u, ''))
  const root = base.href.replace(/\/+$/u, '')
  const flavor = options.flavor ?? (isCloud(base) ? 'cloud' : 'datacenter')
  const api = flavor === 'cloud' ? `${root}/rest/api/3` : `${root}/rest/api/2`
  const browse = base.hostname === 'api.atlassian.com' ? undefined : `${root}/browse`
  const projects = options.projects?.length ? new Set(options.projects) : undefined
  const send = options.fetch ?? fetch
  const authorization =
    options.auth.kind === 'basic'
      ? `Basic ${btoa(`${options.auth.email}:${options.auth.token}`)}`
      : `Bearer ${options.auth.token}`
  const fields = 'summary,status,issuetype'

  const get = async (url: string): Promise<{ status: number; body: unknown }> => {
    let response: Response
    try {
      response = await send(url, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
        redirect: 'error',
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new JiraApiError(0, `Jira GET ${new URL(url).pathname} failed: ${reason.slice(0, 300)}`)
    }
    const text = await response.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    return { status: response.status, body }
  }

  const toIssue = (raw: z.infer<typeof issueSchema>): Issue => {
    const category = categories[raw.fields.status?.statusCategory?.key ?? '']
    return {
      key: raw.key,
      title: raw.fields.summary ?? raw.key,
      ...(raw.fields.status?.name ? { status: raw.fields.status.name } : {}),
      ...(category ? { category } : {}),
      ...(raw.fields.issuetype?.name ? { type: raw.fields.issuetype.name } : {}),
      ...(browse ? { url: `${browse}/${raw.key}` } : {}),
    }
  }

  const one = async (key: string): Promise<Issue | undefined> => {
    const { status, body } = await get(`${api}/issue/${key}?fields=${fields}`)
    if (status === 404) return undefined
    if (status !== 200) throw failed(`issue ${key}`, status)
    const parsed = issueSchema.safeParse(body)
    return parsed.success ? toIssue(parsed.data) : undefined
  }

  const singly = async (keys: readonly string[]) => {
    const found: Issue[] = []
    for (let at = 0; at < keys.length; at += SINGLE_CONCURRENCY) {
      // oxlint-disable-next-line no-await-in-loop -- a few requests at a time keep Jira's rate limits
      const issues = await Promise.all(keys.slice(at, at + SINGLE_CONCURRENCY).map(one))
      found.push(...issues.filter((issue) => issue !== undefined))
    }
    return found
  }

  const batch = async (keys: readonly string[]) => {
    const params = new URLSearchParams({
      jql: `key in (${keys.join(',')})`,
      fields,
      maxResults: String(keys.length),
      ...(flavor === 'datacenter' ? { validateQuery: 'warn' } : {}),
    })
    const path = flavor === 'cloud' ? 'search/jql' : 'search'
    const { status, body } = await get(`${api}/${path}?${params.toString()}`)
    if (status === 400) return singly(keys)
    if (status !== 200) throw failed('search', status)
    const parsed = searchSchema.safeParse(body)
    if (!parsed.success)
      throw new JiraApiError(status, 'Jira search returned an unexpected response')
    return parsed.data.issues.map(toIssue)
  }

  return {
    provider: 'jira',
    async issues(keys) {
      const valid = [...new Set(keys)].filter(
        (key) => KEY.test(key) && (!projects || projects.has(key.slice(0, key.lastIndexOf('-')))),
      )
      const found: Issue[] = []
      for (let at = 0; at < valid.length; at += BATCH)
        // oxlint-disable-next-line no-await-in-loop -- one search after another
        found.push(...(await batch(valid.slice(at, at + BATCH))))
      return found
    },
  }
}

/** Credential kind for Jira sites; the secret is the API token or personal access token. */
export const JIRA_CREDENTIAL_KIND = 'jira'

const sharedOptions = {
  flavor: z.enum(['cloud', 'datacenter']).optional(),
  projects: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]+$/u, { message: 'must be a project key like ABC' }))
    .optional(),
}

const optionsSchema = z.discriminatedUnion('authKind', [
  z.object({
    authKind: z.literal('basic'),
    email: z.string().trim().min(1).includes('@', { message: 'must be an email address' }),
    ...sharedOptions,
  }),
  z.object({ authKind: z.literal('bearer'), ...sharedOptions }),
])

/**
 * A `CredentialOptionsValidator` for `@holtkeeper/credentials`: checks `jira` options and returns
 * `field: message` problems; `undefined` for other kinds.
 */
export function validateJiraCredentialOptions(
  kind: string,
  options: Record<string, unknown> | undefined,
): string[] | undefined {
  if (kind !== JIRA_CREDENTIAL_KIND) return undefined
  const parsed = optionsSchema.safeParse(options ?? {})
  if (parsed.success) return []
  return parsed.error.issues.map(
    (issue) => `options.${issue.path.join('.') || '(root)'}: ${issue.message}`,
  )
}

/**
 * The tracker of a stored `jira` credential (`url`, options `{ authKind: 'basic', email }` or
 * `{ authKind: 'bearer' }`, optional `flavor` and `projects`) and its revealed secret. Throws when the kind or
 * options are wrong.
 */
export function jiraFromCredential(
  credential: { kind: string; url: string; options?: Record<string, unknown> },
  secret: string,
  overrides: Pick<JiraOptions, 'fetch'> = {},
): IssueTracker {
  if (credential.kind !== JIRA_CREDENTIAL_KIND)
    throw new Error(`expected a ${JIRA_CREDENTIAL_KIND} credential, got ${credential.kind}`)
  const parsed = optionsSchema.safeParse(credential.options ?? {})
  if (!parsed.success)
    throw new Error(
      `invalid jira credential options: ${validateJiraCredentialOptions(credential.kind, credential.options)!.join('; ')}`,
    )
  const options = parsed.data
  return jiraTracker({
    url: credential.url,
    auth:
      options.authKind === 'basic'
        ? { kind: 'basic', email: options.email, token: secret }
        : { kind: 'bearer', token: secret },
    ...(options.flavor ? { flavor: options.flavor } : {}),
    ...(options.projects ? { projects: options.projects } : {}),
    ...overrides,
  })
}
