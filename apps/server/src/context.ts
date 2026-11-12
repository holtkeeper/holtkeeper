import type { Action, Principal, RepoTarget, Target } from '@holtkeeper/access'
import { can } from '@holtkeeper/access'
import type { Agent, AiCatalog, AiProviderPlugin, LanguageModelFactory } from '@holtkeeper/agent'
import { ToolError } from '@holtkeeper/agent-tools'
import type { ForbiddenError, JobAnalyzerView } from '@holtkeeper/api'
import type { ArtifactStore, StorageProvider } from '@holtkeeper/artifacts'
import type { AuthProvider } from '@holtkeeper/auth'
import { type HoltkeeperConfig, groupPathLabel, resolveRepo } from '@holtkeeper/core'
import type { CredentialService } from '@holtkeeper/credentials'
import type { CommandRunner } from '@holtkeeper/exec'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import type { IssueTracker } from '@holtkeeper/issues'
import type { AnyAnalyzer } from '@holtkeeper/jobs'
import type { Limiter } from '@holtkeeper/limits'
import type { ConfigSource } from '@holtkeeper/managed-config'
import type { AnalysisKind } from '@holtkeeper/report'
import type { SettingDefinition } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import type { DocumentSink } from '@holtkeeper/tracker'
import type { Vault } from '@holtkeeper/vault'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'

import type { AuditEnrichment } from './audit.ts'
import type { ChatAgentFor } from './chat-threads.ts'
import type { MediaEngine } from './media/engine.ts'
import type { ReadOnlyRepos } from './read-only.ts'
import type { SupplyToolsAccess } from './tools/repos.ts'

/** Everything route handlers use. Built once by `createServer`; tests build it with fakes. */
export interface ServerDeps {
  /** Where tracker publications are written, by provider, for a repository or group. */
  documentSinks?: (
    repo: RepoRef,
  ) => Record<string, DocumentSink> | Promise<Record<string, DocumentSink>>
  /**
   * The effective config. With `configSource` it is a live view (`liveConfig`) that reads the
   * current config on every property access, so values captured from it stay current.
   */
  config: HoltkeeperConfig
  /** Panel-managed configuration; config routes answer 503 without it. */
  configSource?: ConfigSource
  /** The `repo.freeze` setting; events of frozen repositories other than tags are ignored. */
  readOnly?: ReadOnlyRepos
  /** The running release `/api/me` reports. Default: the `HOLTKEEPER_VERSION` environment variable. */
  version?: string
  /** Shared per-credential limits for forge clients, agents and job admission. */
  limiter?: Limiter
  auth: AuthProvider
  store: Store
  vault: Vault
  credentials: CredentialService
  settings: SettingDefinition[]
  /** Analysis kinds the server accepts and renders. */
  // oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
  analyses: AnalysisKind<any>[]
  /** Analyzers jobs may run; job routes validate kinds and options against them. */
  analyzers?: JobAnalyzerInfo[]
  /** Generated files (image variants, optimized SVGs); artifact and media routes answer 503 without it. */
  artifacts?: ArtifactStore
  /** Image engine of the media routes. Default: `@holtkeeper/media`, loaded on first use. */
  media?: MediaEngine
  /**
   * Findings and licenses per asker, shared by their HTTP routes, MCP and chat so they keep one
   * fleet cache each. Default: one `supplyToolsAccess` per `createApp`.
   */
  supply?: (principal: Principal) => SupplyToolsAccess
  /** Provider and model catalog of `ai-sdk` credentials; catalog routes answer an error without it. */
  aiCatalog?: AiCatalog
  /** AI providers from the config's `ai.providers`, which `ai-sdk` credentials may name. */
  aiProviders?: readonly AiProviderPlugin[]
  /**
   * The agent of a repository, for work routes run outside jobs when a person asks (release
   * summaries, API answers); its runs count as interactive for the AI budget.
   */
  agentFor?: (repo: RepoRef) => Promise<Agent | undefined>
  /**
   * The agent of a repository for automatic work the server does outside jobs (learning capture
   * from review replies); its runs are not interactive, so they leave the budget reserve alone.
   */
  automaticAgentFor?: (repo: RepoRef) => Promise<Agent | undefined>
  /**
   * The agent of team chat replies and summaries (`ChatAgentFor`); its runs are interactive work
   * of the person who asked. Without it the chat answers that no AI provider is configured.
   */
  chatAgentFor?: ChatAgentFor
  /** Replaces the AI SDK models of `ai-sdk` credential tests; for tests. */
  languageModel?: LanguageModelFactory
  /** Replaces `fetch` of the agent-loop probe of Anthropic credential tests; for tests. */
  probeFetch?: typeof fetch
  /** Runs host tools for routes, such as `ssh-keyscan` when a forge issues an SSH key. Default: `localRunner`. */
  hostRunner?: CommandRunner
  /** Areas the storage overview reports, e.g. artifacts, git mirrors, the database. */
  storage?: StorageProvider[]
  /**
   * The issue tracker release pages and tools enrich ticket keys with. Default: `issueTrackerFor`,
   * from `jira` credentials; tests pass a fake.
   */
  issueTracker?: (repo: RepoRef) => Promise<IssueTracker | undefined>
  /** How often the release assistant polls a started deploy, in milliseconds. Default 15 s. */
  releasePollMs?: number
  /** How long forge events wait before the release snapshot of a repository is reread, in milliseconds. Default 30 s. */
  releaseRefreshDelayMs?: number
  /** Receives work routes leave running after responding, e.g. an analysis backfill; for tests. */
  onBackground?: (work: Promise<unknown>) => void
  now: () => Date
}

/** What the job routes need to know about an analyzer; every `Analyzer` satisfies it. */
export interface JobAnalyzerInfo {
  kind: string
  scope: 'repo' | 'group'
  options: z.ZodType
  /** `kind` is the record kind the analyzer stores, when it differs from the analyzer's own. */
  analysis?: { label: string; kind?: string }
  needs?: JobAnalyzerView['needs']
  presets?: { id: string; label: string; description?: string; options: unknown }[]
  /** The run changes repositories; `jobs.onNewRepo` never queues it. */
  exclusive?: boolean
  /** Kinds whose results the run reads; its jobs wait for theirs on the same repository. */
  after?: string[]
  /** The run reads only the default branch; event triggers and policies, whose jobs carry a ref, skip it. */
  defaultBranchOnly?: boolean
  appliesTo?: AnyAnalyzer['appliesTo']
  /** How the freshness sweeper keeps its records current; absent: never automatically. */
  refresh?: AnyAnalyzer['refresh']
}

export interface Env {
  Variables: {
    principal: Principal | undefined
    audit?: AuditEnrichment
    /** `forge:path` of every repository a permission check of this request allowed. */
    allowedRepos?: string[]
  }
}

export type AppContext = Context<Env>

/** The caller, or a 401 when the request is anonymous. */
export function principalOf(c: AppContext): Principal {
  const principal = c.get('principal')
  if (!principal) throw new HTTPException(401, { message: 'sign in first' })
  return principal
}

/** `forge:path` of a repository, the key clients send and audit events name. */
export const repoKey = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/**
 * A 403 answered with a `ForbiddenError` body: the missing `action` and, for a repository, its key
 * as the client sent it. Callers never pass groups, and pass the same target whether the
 * repository exists or not.
 */
export class ForbiddenException extends HTTPException {
  readonly missing: ForbiddenError['missing']

  constructor(action: Action, target?: string, message = `missing permission ${action}`) {
    super(403, { message })
    this.missing = target === undefined ? { action } : { action, target }
  }

  body(): ForbiddenError {
    return { error: this.message, missing: this.missing }
  }
}

/**
 * A tool refusal for a missing permission. The MCP endpoint answers it as an error result whose
 * `structuredContent` is the same `ForbiddenError` body the HTTP API sends.
 */
export class ForbiddenToolError extends ToolError {
  readonly missing: ForbiddenError['missing']

  constructor(message: string, action: Action, target?: string) {
    super(message)
    this.missing = target === undefined ? { action } : { action, target }
  }
}

/**
 * Throws `ForbiddenException` unless the caller may perform `action` on `target`. An allowed
 * repository target is remembered for the request, so its audit event may name that repository.
 */
export function authorize(c: AppContext, action: Action, target: Target): Principal {
  if (!can(principalOf(c), action, target))
    throw new ForbiddenException(action, target.kind === 'repo' ? repoKey(target.repo) : undefined)
  return authorizeRecord(c, action, target)
}

/**
 * `authorize` for a repository resolved from a stored record rather than sent by the client: the
 * 403 names only the action, so a record id never reveals the repository it belongs to.
 */
export function authorizeRecord(c: AppContext, action: Action, target: Target): Principal {
  const principal = principalOf(c)
  if (!can(principal, action, target)) throw new ForbiddenException(action)
  if (target.kind === 'repo')
    c.set('allowedRepos', [...(c.get('allowedRepos') ?? []), repoKey(target.repo)])
  return principal
}

/**
 * Names group keys in chat, agent and MCP text: `Title (key)` when the group has a title, else the
 * key; a subgroup shows its parent first (`Shapes › Round (shapes.round)`). Reads `config` on every
 * call, so a live config stays current.
 */
export const groupLabeler =
  (config: Pick<HoltkeeperConfig, 'groups'>) =>
  (key: string): string =>
    groupPathLabel(config.groups, key)

/** A repository with the groups the config assigns to it. */
export const repoTarget = (config: HoltkeeperConfig, repo: RepoRef): RepoTarget => ({
  ...repo,
  groups: resolveRepo(config, repo).groups,
})

/** Parses `forge:path` from a query parameter. */
export function parseRepo(value: string | undefined): RepoRef | undefined {
  if (!value) return undefined
  const separator = value.indexOf(':')
  if (separator < 1 || separator === value.length - 1) {
    throw new HTTPException(400, { message: 'repo must look like <forge>:<path>' })
  }
  return { forge: value.slice(0, separator), path: value.slice(separator + 1) }
}

interface ZodLike<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }
}

const parseOr400 = <T>(schema: ZodLike<T>, value: unknown, fallback: string): T => {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.map(String).join('.')
    throw new HTTPException(400, {
      message: issue ? `${path ? `${path}: ` : ''}${issue.message}` : fallback,
    })
  }
  return result.data
}

/** Parses a JSON body with a zod-like schema, answering 400 with the first problem. */
export async function readBody<T>(c: AppContext, schema: ZodLike<T>): Promise<T> {
  const body: unknown = await c.req.json().catch(() => undefined)
  return parseOr400(schema, body, 'invalid body')
}

/**
 * Parses the query string with a zod-like schema, empty values counting as absent, answering 400
 * with the first problem in the same shape as `readBody`.
 */
export function readQuery<T>(c: AppContext, schema: ZodLike<T>): T {
  const query = Object.fromEntries(
    Object.entries(c.req.query()).filter(([, value]) => value !== ''),
  )
  return parseOr400(schema, query, 'invalid query')
}

export const limitParam = (value: string | undefined, fallback = 50) =>
  Math.min(Math.max(Number(value) || fallback, 1), 500)

/** The forge client for a configured forge id, or 409 when the config cannot reach it. */
export function forgeFor(config: HoltkeeperConfig, forgeId: string): GitForge {
  const definition = config.forges[forgeId]
  if (!definition) throw new HTTPException(409, { message: `forge ${forgeId} is not configured` })
  try {
    return definition.create()
  } catch (error) {
    throw new HTTPException(409, {
      message: `forge ${forgeId} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/** The artifact store, or 503 when the server runs without one. */
export function artifactsOf(deps: ServerDeps): ArtifactStore {
  if (!deps.artifacts) throw new HTTPException(503, { message: 'no artifact store is configured' })
  return deps.artifacts
}

/** `server.publicUrl` without a trailing slash, else the origin of the request. */
export function publicUrlOf(deps: Pick<ServerDeps, 'config'>, c: AppContext): string {
  const configured = deps.config.server?.publicUrl
  return (configured ?? new URL(c.req.url).origin).replace(/\/+$/, '')
}
