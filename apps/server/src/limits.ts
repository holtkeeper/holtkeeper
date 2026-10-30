import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { ForgeDefinition, ForgeFetch, RepoRef } from '@holtkeeper/forge'
import {
  type LimitPolicy,
  type LimitedCredential,
  type Limiter,
  createLimiter,
  limitsCredentialsSetting,
  limitFetch,
  limitJobs,
  resolveLimitPolicy,
} from '@holtkeeper/limits'
import { resolveSetting } from '@holtkeeper/settings'
import type { Job, SettingEntry, Store } from '@holtkeeper/store'

import { findProviderCredential } from './agent.ts'
import { repoTarget } from './context.ts'

/** Limiter key of a file-config forge that has no stored credential. */
export const fileForgeKey = (forgeId: string) => `forge:${forgeId}`

/** The `limits.credentials` value for everything (the entry with `scope.all`), if any. */
export function globalLimits(
  entries: readonly SettingEntry[],
): Record<string, LimitPolicy> | undefined {
  const entry = entries.find(
    (e) => e.key === 'limits.credentials' && e.scope.all === true && !e.secret,
  )
  if (!entry) return undefined
  const parsed = limitsCredentialsSetting.schema.safeParse(entry.value)
  return parsed.success ? parsed.data : undefined
}

/**
 * A `fetch` for one forge credential that draws from the shared limiter. The policy is resolved
 * now (kind defaults plus the global `limits.credentials` entry).
 */
export function limitedFetch(
  limiter: Limiter,
  credential: LimitedCredential,
  entries: readonly SettingEntry[],
  base: ForgeFetch = fetch,
): ForgeFetch {
  const policy = resolveLimitPolicy(credential, globalLimits(entries))
  return limitFetch(base, limiter, credential.id, policy)
}

/** File-config forges whose HTTP calls go through the limiter under `forge:<id>`. */
export function limitFileForges(
  forges: Record<string, ForgeDefinition>,
  limiter: Limiter,
  entries: readonly SettingEntry[],
): Record<string, ForgeDefinition> {
  return Object.fromEntries(
    Object.entries(forges).map(([id, forge]) => [
      id,
      forge.withFetch
        ? forge.withFetch((base) =>
            limitedFetch(limiter, { id: fileForgeKey(id), kind: forge.kind }, entries, base),
          )
        : forge,
    ]),
  )
}

export interface JobKeysOptions {
  config: HoltkeeperConfig
  store: Store
  /** Credential id of a panel forge, by forge id. */
  forgeCredential: (forgeId: string) => string | undefined
  /** Whether the analyzer of a job uses an agent. */
  needsAgent: (analyzer: string) => boolean
}

/**
 * Limiter keys a job uses: its forge's credential (or `forge:<id>` for file forges) and, for
 * analyzers that use an agent, the AI provider credential `llm.provider` resolves to for the
 * repository (or `ai:anthropic` for the legacy key).
 */
export function jobLimitKeys(options: JobKeysOptions) {
  return async (job: Job): Promise<string[]> => {
    const keys = [options.forgeCredential(job.repo.forge) ?? fileForgeKey(job.repo.forge)]
    if (!options.needsAgent(job.analyzer)) return keys
    const repo: RepoRef = job.repo
    const target = repoTarget(options.config, repo)
    const entry = resolveSetting(
      await options.store.settings.list('llm.provider'),
      'llm.provider',
      target,
    )
    const reference = typeof entry?.value === 'string' ? entry.value : undefined
    if (!reference) return keys
    const credential = findProviderCredential(
      await options.store.credentials.list(),
      reference,
      target,
    )
    return credential ? [...keys, credential.id] : keys
  }
}

/** The server's shared limiter and the job admission hook built on it. */
export function serverLimits(options: JobKeysOptions & { limiter?: Limiter }) {
  const limiter = options.limiter ?? createLimiter()
  return { limiter, admission: limitJobs<Job>({ limiter, keysFor: jobLimitKeys(options) }) }
}
