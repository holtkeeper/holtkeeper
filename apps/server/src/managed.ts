import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { CredentialService, CredentialView } from '@holtkeeper/credentials'
import { type Limiter, resolveLimitPolicy } from '@holtkeeper/limits'
import {
  type ConfigSource,
  createConfigSource,
  gitlabForgeFactory,
} from '@holtkeeper/managed-config'
import type { SettingEntry, Store } from '@holtkeeper/store'
import type { Vault } from '@holtkeeper/vault'

import { fileForgeKey, globalLimits, limitFileForges, limitedFetch } from './limits.ts'

export interface ManagedConfigOptions {
  file: HoltkeeperConfig
  store: Store
  vault: Vault
  credentials: CredentialService
  limiter: Limiter
  /** How often tokens, limits and documents are re-read. Default one minute; 0 disables it. */
  pollMs?: number
  log?: (line: string) => void
}

/** A running config source plus what keeps it current. */
export interface ManagedConfig {
  source: ConfigSource
  /** Re-reads limit settings and credentials, reconfigures the limiter, then rebuilds the config. */
  refresh(): Promise<void>
  stop(): void
}

/**
 * The server's `ConfigSource`: the file config (its forges' HTTP calls limited under
 * `forge:<id>`) plus the store's panel documents, panel GitLab forges built with their
 * credential's token and a `fetch` limited under the credential id.
 */
export async function startManagedConfig(options: ManagedConfigOptions): Promise<ManagedConfig> {
  const { store, vault, credentials, limiter } = options
  let entries: SettingEntry[] = []
  let views = new Map<string, CredentialView>()

  const loadLimits = async () => {
    entries = await store.settings.list('limits.credentials')
    views = new Map((await credentials.list()).map((view) => [view.id, view]))
    const configured = globalLimits(entries)
    for (const view of views.values())
      limiter.configure(view.id, resolveLimitPolicy(view, configured))
    for (const [id, forge] of Object.entries(options.file.forges))
      limiter.configure(
        fileForgeKey(id),
        resolveLimitPolicy({ id: fileForgeKey(id), kind: forge.kind }, configured),
      )
  }
  await loadLimits()

  const file: HoltkeeperConfig = {
    ...options.file,
    forges: limitFileForges(options.file.forges, limiter, entries),
  }
  const source = await createConfigSource({
    file,
    ...(store.config && { store: store.config }),
    forgeFactories: {
      gitlab: gitlabForgeFactory({
        fetchFor: (doc) => {
          const view = views.get(doc.data.credentialId)
          return limitedFetch(
            limiter,
            view ?? { id: doc.data.credentialId, kind: doc.data.kind },
            entries,
          )
        },
      }),
    },
    revealToken: (id) => credentials.reveal(id),
    openSecret: (sealed) => vault.open(sealed),
    ...(options.log && { log: options.log }),
  })

  const refresh = async () => {
    try {
      await loadLimits()
    } catch (error) {
      options.log?.(`limits: ${error instanceof Error ? error.message : String(error)}`)
    }
    await source.refresh()
  }
  const pollMs = options.pollMs ?? 60_000
  const timer = pollMs > 0 ? setInterval(() => void refresh(), pollMs) : undefined
  timer?.unref?.()

  return {
    source,
    refresh,
    stop() {
      clearInterval(timer)
      source.close()
    },
  }
}
