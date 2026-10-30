import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { ForgeDefinition } from '@holtkeeper/forge'
import type {
  AnyConfigDocument,
  ConfigDocumentInput,
  ConfigDocumentType,
  ConfigStore,
} from '@holtkeeper/store'

import {
  type EffectiveConfig,
  type EffectiveConfigOptions,
  effectiveConfig,
  memoizeForge,
} from './effective.ts'

/** Live access to the effective config. */
export interface ConfigSource {
  /** The latest valid effective config. */
  current(): HoltkeeperConfig
  /** `current()` with provenance and forge origins. */
  effective(): EffectiveConfig
  /** Called after every rebuild that changed something; returns an unsubscribe function. */
  subscribe(listener: (effective: EffectiveConfig) => void): () => void
  /**
   * Re-reads the documents, tokens and webhook secrets and rebuilds. A result that fails
   * validation keeps the previous config (see `lastError`) and does not notify.
   */
  refresh(): Promise<EffectiveConfig>
  /**
   * The effective config documents would produce after putting `put` or removing `remove`,
   * without storing anything. Throws `ConfigError` when it would be invalid.
   */
  preview(change: {
    put?: ConfigDocumentInput
    remove?: { type: ConfigDocumentType; id: string }
  }): Promise<EffectiveConfig>
  /** Why the last rebuild was rejected, until a rebuild succeeds. */
  lastError(): string | undefined
  /** Stops polling. */
  close(): void
}

export interface ConfigSourceOptions {
  /** The validated file config; panel documents are applied on top of it. */
  file: HoltkeeperConfig
  /** Without a store the source serves the file config and never changes. */
  store?: ConfigStore
  forgeFactories: EffectiveConfigOptions['forgeFactories']
  /** The plaintext token of a credential; a rejection makes that forge unavailable. */
  revealToken?: (credentialId: string) => Promise<string>
  /** Opens a sealed webhook secret of a forge document. */
  openSecret?: (sealed: string) => Promise<string>
  /** Rebuild every `pollMs` (picks up rotated tokens and other processes' changes). 0: never. */
  pollMs?: number
  log?: (line: string) => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A `ConfigSource` over the file config and a `ConfigStore`. Panel forge definitions are reused
 * while their document version and token stay the same, and each builds its `GitForge` client
 * once. Throws `ConfigError` when the documents in the store make the initial config invalid.
 */
export async function createConfigSource(options: ConfigSourceOptions): Promise<ConfigSource> {
  const { file, store } = options
  const log = options.log ?? (() => {})
  const listeners = new Set<(effective: EffectiveConfig) => void>()
  const cache = new Map<string, { key: string; definition: ForgeDefinition }>()
  let error: string | undefined
  let fingerprint = ''

  const reuse: EffectiveConfigOptions['reuse'] = (doc, token, build) => {
    const key = `${doc.version}:${token === undefined ? '-' : Bun.hash(token).toString(36)}`
    const cached = cache.get(doc.id)
    if (cached?.key === key) return cached.definition
    const definition = memoizeForge(build())
    cache.set(doc.id, { key, definition })
    return definition
  }

  const inputs = async (documents: readonly AnyConfigDocument[]) => {
    const tokens: Record<string, string> = {}
    const webhookSecrets: Record<string, string> = {}
    for (const doc of documents) {
      if (doc.type !== 'forge') continue
      const { credentialId, webhook } = doc.data
      if (options.revealToken && !(credentialId in tokens)) {
        try {
          tokens[credentialId] = await options.revealToken(credentialId)
        } catch (reason) {
          log(`config: forge ${doc.id}: credential ${credentialId}: ${messageOf(reason)}`)
        }
      }
      if (webhook && options.openSecret) {
        try {
          webhookSecrets[doc.id] = await options.openSecret(webhook.secret)
        } catch (reason) {
          log(`config: forge ${doc.id}: webhook secret: ${messageOf(reason)}`)
        }
      }
    }
    return { tokens, webhookSecrets }
  }

  const build = async (documents: readonly AnyConfigDocument[]) => {
    const { tokens, webhookSecrets } = await inputs(documents)
    const effective = effectiveConfig(file, documents, {
      forgeFactories: options.forgeFactories,
      tokens,
      webhookSecrets,
      reuse,
    })
    const print = [
      ...documents.map((doc) => `${doc.type}:${doc.id}:${doc.version}`),
      ...Object.entries(tokens).map(([id, token]) => `t:${id}:${Bun.hash(token).toString(36)}`),
      ...Object.entries(webhookSecrets).map(([id, s]) => `w:${id}:${Bun.hash(s).toString(36)}`),
    ].join('|')
    return { effective, print }
  }

  const initial = await build(store ? await store.list() : [])
  let state = initial.effective
  fingerprint = initial.print

  const refresh = async () => {
    if (!store) return state
    try {
      const next = await build(await store.list())
      error = undefined
      if (next.print === fingerprint) return state
      fingerprint = next.print
      state = next.effective
      for (const listener of listeners) {
        try {
          listener(state)
        } catch (reason) {
          log(`config: listener failed: ${messageOf(reason)}`)
        }
      }
    } catch (reason) {
      error = messageOf(reason)
      log(`config: keeping the previous config: ${error}`)
    }
    return state
  }

  const timer =
    store && options.pollMs ? setInterval(() => void refresh(), options.pollMs) : undefined
  timer?.unref?.()

  return {
    current: () => state.config,
    effective: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    async preview(change) {
      const documents = (store ? await store.list() : []).filter(
        (doc) =>
          !(change.put && doc.type === change.put.type && doc.id === change.put.id) &&
          !(change.remove && doc.type === change.remove.type && doc.id === change.remove.id),
      )
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an input is a document without version
      if (change.put) documents.push({ ...change.put, version: 0 } as AnyConfigDocument)
      return (await build(documents)).effective
    },
    lastError: () => error,
    close: () => clearInterval(timer),
  }
}

/**
 * A config object that always reads through to `source.current()`, for code that captures a
 * config once (route factories, the job engine). Each top-level property read returns the
 * current value; nested objects are the current config's own objects.
 */
export function liveConfig(source: Pick<ConfigSource, 'current'>): HoltkeeperConfig {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every read is forwarded to a real config
  return new Proxy({} as HoltkeeperConfig, {
    get: (_, key) => Reflect.get(source.current(), key),
    has: (_, key) => Reflect.has(source.current(), key),
    ownKeys: () => Reflect.ownKeys(source.current()),
    getOwnPropertyDescriptor: (_, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(source.current(), key)
      return descriptor && { ...descriptor, configurable: true }
    },
    set: () => false,
  })
}
