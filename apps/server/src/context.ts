import type { Action, Principal, RepoTarget, Target } from '@holtkeeper/access'
import { can } from '@holtkeeper/access'
import type { Agent, AiCatalog, AiProviderPlugin, LanguageModelFactory } from '@holtkeeper/agent'
import type { JobAnalyzerView } from '@holtkeeper/api'
import type { ArtifactStore, StorageProvider } from '@holtkeeper/artifacts'
import type { AuthProvider } from '@holtkeeper/auth'
import { type HoltkeeperConfig, resolveRepo } from '@holtkeeper/core'
import type { CredentialService } from '@holtkeeper/credentials'
import type { CommandRunner } from '@holtkeeper/exec'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
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
import type { MediaEngine } from './media/engine.ts'
import type { ReadOnlyRepos } from './read-only.ts'

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
  /** The `repo.readOnly` setting; events of read-only repositories other than tags are ignored. */
  readOnly?: ReadOnlyRepos
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
  /** Provider and model catalog of `ai-sdk` credentials; catalog routes answer an error without it. */
  aiCatalog?: AiCatalog
  /** AI providers from the config's `ai.providers`, which `ai-sdk` credentials may name. */
  aiProviders?: readonly AiProviderPlugin[]
  /** The agent of a repository, for work routes run outside jobs (library issue digests). */
  agentFor?: (repo: RepoRef) => Promise<Agent | undefined>
  /** Replaces the AI SDK models of `ai-sdk` credential tests; for tests. */
  languageModel?: LanguageModelFactory
  /** Runs host tools for routes, such as `ssh-keyscan` when a forge issues an SSH key. Default: `localRunner`. */
  hostRunner?: CommandRunner
  /** Areas the storage overview reports, e.g. artifacts, git mirrors, the database. */
  storage?: StorageProvider[]
  /** Receives work routes leave running after responding, e.g. a release backfill; for tests. */
  onBackground?: (work: Promise<unknown>) => void
  now: () => Date
}

/** What the job routes need to know about an analyzer; every `Analyzer` satisfies it. */
export interface JobAnalyzerInfo {
  kind: string
  scope: 'repo' | 'group'
  options: z.ZodType
  analysis?: { label: string }
  needs?: JobAnalyzerView['needs']
  presets?: { id: string; label: string; description?: string; options: unknown }[]
}

export interface Env {
  Variables: { principal: Principal | undefined; audit?: AuditEnrichment }
}

export type AppContext = Context<Env>

/** The caller, or a 401 when the request is anonymous. */
export function principalOf(c: AppContext): Principal {
  const principal = c.get('principal')
  if (!principal) throw new HTTPException(401, { message: 'sign in first' })
  return principal
}

/** Throws 403 unless the caller may perform `action` on `target`. */
export function authorize(c: AppContext, action: Action, target: Target): Principal {
  const principal = principalOf(c)
  if (!can(principal, action, target))
    throw new HTTPException(403, { message: `missing permission ${action}` })
  return principal
}

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

/** Parses a JSON body with a zod-like schema, answering 400 with the first problem. */
export async function readBody<T>(
  c: AppContext,
  schema: {
    safeParse(
      value: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }
  },
): Promise<T> {
  const body: unknown = await c.req.json().catch(() => undefined)
  const result = schema.safeParse(body)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.map(String).join('.')
    throw new HTTPException(400, {
      message: issue ? `${path ? `${path}: ` : ''}${issue.message}` : 'invalid body',
    })
  }
  return result.data
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
