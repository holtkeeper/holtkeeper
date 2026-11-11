import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { ForgeFetch, RepoRef } from '@holtkeeper/forge'
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
import type { Job, SettingEntry, Store } from '@holtkeeper/store'

import { findProviderCredential, providerReference } from './agent.ts'
import { repoTarget } from './context.ts'

/** Limiter key of a forge that has no stored credential. */
export const forgeLimitKey = (forgeId: string) => `forge:${forgeId}`

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

export interface JobKeysOptions {
  config: HoltkeeperConfig
  store: Store
  /** Credential id of a panel forge, by forge id. */
  forgeCredential: (forgeId: string) => string | undefined
  /** Whether the analyzer of a job uses an agent. */
  needsAgent: (analyzer: string) => boolean
}

/**
 * Limiter keys a job uses: its forge's credential (or `forge:<id>` without one) and, for
 * analyzers that use an agent, the AI provider credential the global `llm.provider` names when its
 * scope covers the repository.
 */
export function jobLimitKeys(options: JobKeysOptions) {
  return async (job: Job): Promise<string[]> => {
    const keys = [options.forgeCredential(job.repo.forge) ?? forgeLimitKey(job.repo.forge)]
    if (!options.needsAgent(job.analyzer)) return keys
    const repo: RepoRef = job.repo
    const target = repoTarget(options.config, repo)
    const reference = providerReference(await options.store.settings.list('llm.provider'))
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
