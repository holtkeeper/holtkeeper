import { createHash, randomBytes } from 'node:crypto'

import type { RepoRef } from '@holtkeeper/forge'
import type { KvStore, RegisteredWebhook } from '@holtkeeper/store'
import type { Vault } from '@holtkeeper/vault'

/** One delivery a repository webhook received. */
export interface RepoHookDelivery {
  at: string
  /** Forge event header, e.g. `Merge Request Hook`. */
  event: string
  /** What the event was about, e.g. `push to main, 3 commits`. */
  summary?: string
  /** Jobs queued, or why nothing was. */
  enqueued: number
  ignored?: string
  /** Why the delivery was rejected; nothing ran. */
  error?: string
  durationMs: number
}

/** Deliveries kept per repository webhook; older ones are dropped. */
const MAX_DELIVERIES = 50

/** A repository's own webhook. The token is the secret part of its URL. */
export interface RepoHook {
  /** Sealed with the vault, so the URL can be shown again. */
  token: string
  createdAt: string
  createdBy?: string
  /** Hooks Holtkeeper registered on the forge for this URL. */
  registered?: RegisteredWebhook[]
}

const isRepoHook = (value: unknown): value is RepoHook =>
  typeof value === 'object' && value !== null && 'token' in value && 'createdAt' in value

const isDelivery = (value: unknown): value is RepoHookDelivery =>
  typeof value === 'object' && value !== null && 'at' in value && 'event' in value

const isRepoRef = (value: unknown): value is RepoRef =>
  typeof value === 'object' && value !== null && 'forge' in value && 'path' in value

const hookKey = (repo: RepoRef) => `repo-hook:${repo.forge}:${repo.path}`
const deliveriesKey = (repo: RepoRef) => `repo-hook-deliveries:${repo.forge}:${repo.path}`
const tokenKey = (token: string) =>
  `repo-hook-token:${createHash('sha256').update(token).digest('hex')}`

/** Path of a repository webhook URL below the public URL. */
export const repoHookPath = (token: string) => `/api/webhooks/r/${token}`

/**
 * Per-repository webhooks in the store's key-value part. Each repository has at most one token;
 * rotating it makes the previous URL fail at once. Tokens are found by their SHA-256, so a lookup
 * never opens sealed values.
 */
export function repoHooks(kv: KvStore, vault: Vault) {
  const get = async (repo: RepoRef) => {
    const value = await kv.get(hookKey(repo))
    return isRepoHook(value) ? value : undefined
  }

  const drop = async (hook: RepoHook | undefined) => {
    if (hook) await kv.delete(tokenKey(await vault.open(hook.token)))
  }

  return {
    get,
    /** The token of the repository's webhook, opened. */
    async token(hook: RepoHook) {
      return vault.open(hook.token)
    },
    /** Issues a new token and forgets the old one; registered hooks are kept for the caller. */
    async rotate(repo: RepoRef, at: string, by?: string) {
      const previous = await get(repo)
      await drop(previous)
      const token = randomBytes(24).toString('base64url')
      const hook: RepoHook = {
        token: await vault.seal(token),
        createdAt: at,
        ...(by !== undefined && { createdBy: by }),
        ...(previous?.registered && { registered: previous.registered }),
      }
      await kv.set(tokenKey(token), repo)
      await kv.set(hookKey(repo), hook)
      return { token, hook, previous }
    },
    async save(repo: RepoRef, hook: RepoHook) {
      await kv.set(hookKey(repo), hook)
    },
    async remove(repo: RepoRef) {
      const hook = await get(repo)
      await drop(hook)
      await kv.delete(hookKey(repo))
      await kv.delete(deliveriesKey(repo))
      return hook
    },
    /** The repository a token belongs to. */
    async find(token: string): Promise<RepoRef | undefined> {
      const value = await kv.get(tokenKey(token))
      return isRepoRef(value) ? value : undefined
    },
    /** The repository's recent deliveries, newest first, at most `MAX_DELIVERIES`. */
    async deliveries(repo: RepoRef): Promise<RepoHookDelivery[]> {
      const value = await kv.get(deliveriesKey(repo))
      return Array.isArray(value) ? value.filter(isDelivery) : []
    },
    /**
     * Adds a delivery in front of the repository's ring of recent deliveries. The ring has its own
     * key, so it never rewrites the token or the registered hooks.
     */
    async recordDelivery(repo: RepoRef, delivery: RepoHookDelivery) {
      const key = deliveriesKey(repo)
      for (let attempt = 0; attempt < 5; attempt++) {
        // oxlint-disable-next-line no-await-in-loop -- retries a lost compare-and-set
        const current = await kv.get(key)
        const next = [delivery, ...(Array.isArray(current) ? current : [])].slice(0, MAX_DELIVERIES)
        if (!kv.compareAndSet) return kv.set(key, next)
        // oxlint-disable-next-line no-await-in-loop -- retries a lost compare-and-set
        if (await kv.compareAndSet(key, current, next)) return
      }
    },
  }
}

export type RepoHooks = ReturnType<typeof repoHooks>
