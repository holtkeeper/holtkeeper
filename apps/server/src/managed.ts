import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { CredentialService, CredentialView } from '@holtkeeper/credentials'
import { type ForgeDefinition, readOnlyDefinition } from '@holtkeeper/forge'
import { type Limiter, resolveLimitPolicy } from '@holtkeeper/limits'
import {
  type ConfigSource,
  createConfigSource,
  gitlabForgeFactory,
} from '@holtkeeper/managed-config'
import type { SettingEntry, Store } from '@holtkeeper/store'
import type { Vault } from '@holtkeeper/vault'

import { fileForgeKey, globalLimits, limitFileForges, limitedFetch } from './limits.ts'
import { type ReadOnlyRepos, readOnlyRepos } from './read-only.ts'

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
  /** The `repo.readOnly` setting; every forge client of `source` already refuses writes it forbids. */
  readOnly: ReadOnlyRepos
  /** Re-reads limit settings and credentials, reconfigures the limiter, then rebuilds the config. */
  refresh(): Promise<void>
  stop(): void
}

/**
 * The server's `ConfigSource`: the file config (its forges' HTTP calls limited under
 * `forge:<id>`) plus the store's panel documents, panel GitLab forges built with their
 * credential's token and a `fetch` limited under the credential id. Every forge client refuses
 * changes to repositories the `repo.readOnly` setting marks read-only.
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

  let current = (): HoltkeeperConfig => options.file
  const readOnly = readOnlyRepos(store, () => current())
  const guarded = (id: string, definition: ForgeDefinition) =>
    readOnlyDefinition(definition, (path) => readOnly({ forge: id, path }))
  const gitlab = gitlabForgeFactory({
    fetchFor: (doc) => {
      const view = views.get(doc.data.credentialId)
      return limitedFetch(
        limiter,
        view ?? { id: doc.data.credentialId, kind: doc.data.kind },
        entries,
      )
    },
  })

  const file: HoltkeeperConfig = {
    ...options.file,
    forges: Object.fromEntries(
      Object.entries(limitFileForges(options.file.forges, limiter, entries)).map(
        ([id, definition]) => [id, guarded(id, definition)],
      ),
    ),
  }
  const source = await createConfigSource({
    file,
    ...(store.config && { store: store.config }),
    forgeFactories: { gitlab: (doc, token) => guarded(doc.id, gitlab(doc, token)) },
    revealToken: (id) => credentials.reveal(id),
    openSecret: (sealed) => vault.open(sealed),
    ...(options.log && { log: options.log }),
  })
  current = () => source.current()

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
    readOnly,
    refresh,
    stop() {
      clearInterval(timer)
      source.close()
    },
  }
}
