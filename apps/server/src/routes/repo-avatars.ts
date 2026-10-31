import type { RepoAvatarInfo } from '@holtkeeper/api'
import { type ForgeImage, type RepoRef, imageType } from '@holtkeeper/forge'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  repoTarget,
} from '../context.ts'
import { generatedRepoAvatar } from '../repo-avatar.ts'

/** Largest uploaded avatar. */
const MAX_BYTES = 512 * 1024
/** How long a forge avatar (or its absence) is served before it is refreshed in the background. */
const FORGE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_ENTRIES = 1024
/** How long a request waits for the forge before it gets the generated avatar instead. */
const FORGE_WAIT_MS = 2_000
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

interface StoredAvatar {
  contentType: string
  /** Base64 of the image. */
  data: string
  updatedAt: string
  updatedBy: string
}

const kvKey = (repo: RepoRef) => `repo-avatar:${repo.forge}:${repo.path}`
const refName = (repo: RepoRef) => `repo-avatars/${repo.forge}/${repo.path}`

interface CachedAvatar {
  /** Absent when the forge has none. */
  image?: ForgeImage
  at: number
}

const etagOf = (data: Uint8Array | string) =>
  `"${new Bun.CryptoHasher('sha1').update(data).digest('hex')}"`

const isStored = (value: unknown): value is StoredAvatar =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { data?: unknown }).data === 'string' &&
  typeof (value as { contentType?: unknown }).contentType === 'string'

/** The image with an ETag; 304 when the client already has it. */
const send = (c: AppContext, body: Uint8Array | string, contentType: string) => {
  const etag = etagOf(body)
  const headers = {
    ETag: etag,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  }
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers)
  const typed = { ...headers, 'Content-Type': contentType }
  return typeof body === 'string'
    ? c.body(body, 200, typed)
    : c.body(new Uint8Array(body), 200, typed)
}

/**
 * Repository avatars: an uploaded one, else the forge's (the project's or its nearest group's),
 * else a generated one with the repository's initials. Forge avatars are kept in the artifact
 * store under the ref `repo-avatars/<forge>/<path>`, so restarts and other processes reuse them.
 */
export function repoAvatarRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const forgeCache = new Map<string, CachedAvatar>()
  const pending = new Map<string, Promise<ForgeImage | undefined>>()

  const target = (c: AppContext, action: 'repos:read' | 'settings:write') => {
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    const principal = authorize(c, action, { kind: 'repo', repo: repoTarget(config, repo) })
    return { repo, principal }
  }

  const stored = async (repo: RepoRef) => {
    const value = await store.kv?.get(kvKey(repo))
    return isStored(value) ? value : undefined
  }

  const remember = (key: string, entry: CachedAvatar) => {
    forgeCache.delete(key)
    forgeCache.set(key, entry)
    if (forgeCache.size > CACHE_ENTRIES) {
      const oldest = forgeCache.keys().next().value
      if (oldest !== undefined) forgeCache.delete(oldest)
    }
  }

  const readSaved = async (repo: RepoRef): Promise<CachedAvatar | undefined> => {
    const artifacts = deps.artifacts
    if (!artifacts) return undefined
    try {
      const ref = await artifacts.getRef(refName(repo))
      if (!ref) return undefined
      const at = Date.parse(ref.updatedAt)
      if (ref.meta?.none) return { at }
      const artifact = await artifacts.get(ref.id)
      return artifact && { image: { data: artifact.data, contentType: artifact.contentType }, at }
    } catch {
      return undefined
    }
  }

  const save = async (repo: RepoRef, image: ForgeImage | undefined) => {
    const artifacts = deps.artifacts
    if (!artifacts) return
    try {
      const { id } = await artifacts.put(image?.data ?? new Uint8Array(), {
        contentType: image?.contentType ?? 'application/octet-stream',
        tags: { kind: 'repo-avatar', repo: `${repo.forge}:${repo.path}` },
      })
      await artifacts.setRef(refName(repo), { id, ...(!image && { meta: { none: true } }) })
    } catch {
      // The memory cache still holds it; the next process asks the forge again.
    }
  }

  /** Asks the forge once per repository at a time and keeps the answer in memory and storage. */
  const refresh = (repo: RepoRef, key: string) => {
    let lookup = pending.get(key)
    if (lookup) return lookup
    lookup = (async () => {
      let image: ForgeImage | undefined
      let failed = false
      try {
        image = await config.forges[repo.forge]?.create().getRepositoryAvatar?.(repo.path)
      } catch {
        failed = true
      }
      remember(key, { ...(image && { image }), at: deps.now().getTime() })
      if (!failed) await save(repo, image)
      return image
    })().finally(() => pending.delete(key))
    pending.set(key, lookup)
    return lookup
  }

  /**
   * The forge's avatar from memory or storage, refreshed in the background once older than
   * `FORGE_TTL_MS`. Without either, the forge is asked; `'pending'` when it has not answered
   * within `FORGE_WAIT_MS`, so a busy forge budget never holds up a page.
   */
  const forgeAvatar = async (repo: RepoRef): Promise<ForgeImage | undefined | 'pending'> => {
    const key = `${repo.forge}:${repo.path}`
    const known = forgeCache.get(key) ?? (await readSaved(repo))
    if (known) {
      if (!forgeCache.has(key)) remember(key, known)
      if (deps.now().getTime() - known.at >= FORGE_TTL_MS)
        void refresh(repo, key).catch(() => undefined)
      return known.image
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), FORGE_WAIT_MS)
    })
    try {
      return await Promise.race([refresh(repo, key), late])
    } finally {
      clearTimeout(timer)
    }
  }

  app.get('/repos/avatar', async (c) => {
    const { repo } = target(c, 'repos:read')
    const own = await stored(repo)
    if (own) return send(c, Uint8Array.fromBase64(own.data), own.contentType)
    const forge = await forgeAvatar(repo)
    if (forge && forge !== 'pending') return send(c, forge.data, forge.contentType)
    return send(c, generatedRepoAvatar(repo), 'image/svg+xml')
  })

  app.get('/repos/avatar/info', async (c) => {
    const { repo } = target(c, 'repos:read')
    const own = await stored(repo)
    if (own)
      return c.json<RepoAvatarInfo>({
        source: 'custom',
        updatedAt: own.updatedAt,
        updatedBy: own.updatedBy,
      })
    const forge = await forgeAvatar(repo)
    return c.json<RepoAvatarInfo>({ source: forge && forge !== 'pending' ? 'forge' : 'generated' })
  })

  app.put('/repos/avatar', async (c) => {
    const { repo, principal } = target(c, 'settings:write')
    if (!store.kv) throw new HTTPException(501, { message: 'this store cannot keep avatars' })
    const data = new Uint8Array(await c.req.arrayBuffer())
    if (data.byteLength === 0) throw new HTTPException(400, { message: 'the image is empty' })
    if (data.byteLength > MAX_BYTES)
      throw new HTTPException(413, { message: `the image is larger than ${MAX_BYTES / 1024} kB` })
    const contentType = imageType(data)
    if (!contentType || !UPLOAD_TYPES.has(contentType))
      throw new HTTPException(415, { message: 'upload a PNG, JPEG, WebP or GIF image' })
    const at = deps.now().toISOString()
    await store.kv.set(kvKey(repo), {
      contentType,
      data: data.toBase64(),
      updatedAt: at,
      updatedBy: principal.id,
    } satisfies StoredAvatar)
    await store.activity.append({
      at,
      actor: principal.id,
      action: 'repo.avatar.set',
      subject: `${repo.forge}:${repo.path}`,
      details: { contentType, bytes: data.byteLength },
    })
    return c.json<RepoAvatarInfo>({ source: 'custom', updatedAt: at, updatedBy: principal.id })
  })

  app.delete('/repos/avatar', async (c) => {
    const { repo, principal } = target(c, 'settings:write')
    if (!(await stored(repo))) return c.body(null, 204)
    await store.kv?.delete(kvKey(repo))
    await store.activity.append({
      at: deps.now().toISOString(),
      actor: principal.id,
      action: 'repo.avatar.removed',
      subject: `${repo.forge}:${repo.path}`,
    })
    return c.body(null, 204)
  })

  return app
}
