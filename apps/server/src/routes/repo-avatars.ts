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
/** How long a forge avatar (or its absence) is reused before asking the forge again. */
const FORGE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_ENTRIES = 1024
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

interface StoredAvatar {
  contentType: string
  /** Base64 of the image. */
  data: string
  updatedAt: string
  updatedBy: string
}

const kvKey = (repo: RepoRef) => `repo-avatar:${repo.forge}:${repo.path}`

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
 * else a generated one with the repository's initials.
 */
export function repoAvatarRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const forgeCache = new Map<string, { image?: ForgeImage; at: number }>()

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

  const forgeAvatar = async (repo: RepoRef): Promise<ForgeImage | undefined> => {
    const key = `${repo.forge}:${repo.path}`
    const cached = forgeCache.get(key)
    if (cached && deps.now().getTime() - cached.at < FORGE_TTL_MS) return cached.image
    let image: ForgeImage | undefined
    try {
      image = await config.forges[repo.forge]?.create().getRepositoryAvatar?.(repo.path)
    } catch {
      image = undefined
    }
    forgeCache.delete(key)
    forgeCache.set(key, { ...(image ? { image } : {}), at: deps.now().getTime() })
    if (forgeCache.size > CACHE_ENTRIES) {
      const oldest = forgeCache.keys().next().value
      if (oldest !== undefined) forgeCache.delete(oldest)
    }
    return image
  }

  app.get('/repos/avatar', async (c) => {
    const { repo } = target(c, 'repos:read')
    const own = await stored(repo)
    if (own) return send(c, Uint8Array.fromBase64(own.data), own.contentType)
    const forge = await forgeAvatar(repo)
    if (forge) return send(c, forge.data, forge.contentType)
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
    return c.json<RepoAvatarInfo>({ source: (await forgeAvatar(repo)) ? 'forge' : 'generated' })
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
