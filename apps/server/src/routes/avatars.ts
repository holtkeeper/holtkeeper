import { Avatar, Style } from '@dicebear/core'
import type { Principal } from '@holtkeeper/access'
import type { ActivityPerson, MePrincipal, SetAvatarInput } from '@holtkeeper/api'
import type { ActivityEvent } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, principalOf, readBody } from '../context.ts'

/** Where the avatar of a seed is served. */
const avatarUrl = (seed: string) => `/api/avatars/${encodeURIComponent(seed)}.svg`

const MAX_SEED = 128
const MIN_SIZE = 16
const MAX_SIZE = 512
const DEFAULT_SIZE = 128
const CACHE_ENTRIES = 512

let style: Promise<Style> | undefined
const loadStyle = () => {
  style ??= import('@dicebear/styles/voxel-bot.json', { with: { type: 'json' } }).then(
    (module: { default: unknown }) => new Style(module.default),
  )
  return style
}

const rendered = new Map<string, { svg: string; etag: string }>()

/** The `voxel-bot` avatar of `seed` at `size` pixels, with a content ETag; recent ones are cached. */
async function renderAvatar(seed: string, size: number) {
  const key = `${size}\u0000${seed}`
  const cached = rendered.get(key)
  if (cached) {
    rendered.delete(key)
    rendered.set(key, cached)
    return cached
  }
  const svg = new Avatar(await loadStyle(), { seed, size }).toString()
  const etag = `"${new Bun.CryptoHasher('sha1').update(svg).digest('hex')}"`
  const entry = { svg, etag }
  rendered.set(key, entry)
  if (rendered.size > CACHE_ENTRIES) {
    const oldest = rendered.keys().next().value
    if (oldest !== undefined) rendered.delete(oldest)
  }
  return entry
}

/** The caller with its avatar URL; `users` accounts use their `avatarSeed` when set. */
export async function withAvatar(
  deps: Pick<ServerDeps, 'store'>,
  principal: Principal | undefined,
): Promise<MePrincipal | null> {
  if (!principal) return null
  const user =
    principal.provider === 'users' ? await deps.store.users.getUser(principal.id) : undefined
  return { ...principal, avatarUrl: avatarUrl(user?.avatarSeed ?? principal.id) }
}

/** Names and avatars of the users among events' actors and subjects. */
export const activityPeople = (
  deps: Pick<ServerDeps, 'store'>,
  events: readonly ActivityEvent[],
): Promise<Record<string, ActivityPerson>> =>
  peopleOf(
    deps,
    events.flatMap((e) => (e.subject ? [e.actor, e.subject] : [e.actor])),
  )

/** Names and avatars of the ids that are users; other ids (services, `system`) are absent. */
export async function peopleOf(
  deps: Pick<ServerDeps, 'store'>,
  ids: Iterable<string>,
): Promise<Record<string, ActivityPerson>> {
  const unique = new Set(ids)
  const users = await Promise.all([...unique].map((id) => deps.store.users.getUser(id)))
  return Object.fromEntries(
    users.flatMap((user) =>
      user
        ? [[user.id, { name: user.name, avatarUrl: avatarUrl(user.avatarSeed ?? user.id) }]]
        : [],
    ),
  )
}

const setAvatarSchema = z.object({
  seed: z.string().trim().min(1).max(64).nullable(),
})

/**
 * `GET /avatars/<seed>.svg?size=` renders the DiceBear `voxel-bot` style (CC0) locally; anyone may
 * fetch any seed. Responses are immutable for a year and carry an ETag. `PUT /me/avatar` rerolls
 * the caller's avatar (accounts of the `users` provider only).
 */
export function avatarRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  app.get('/avatars/:file', async (c) => {
    const file = c.req.param('file')
    if (!file.endsWith('.svg')) throw new HTTPException(404, { message: 'not found' })
    const seed = file.slice(0, -4)
    if (!seed || seed.length > MAX_SEED) throw new HTTPException(400, { message: 'invalid seed' })
    const sizeParam = c.req.query('size')
    const size = sizeParam === undefined ? DEFAULT_SIZE : Number(sizeParam)
    if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE)
      throw new HTTPException(400, {
        message: `size must be an integer from ${MIN_SIZE} to ${MAX_SIZE}`,
      })

    const { svg, etag } = await renderAvatar(seed, size)
    const headers = {
      etag,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    }
    if (
      c.req
        .header('if-none-match')
        ?.split(',')
        .some((tag) => tag.trim() === etag)
    )
      return new Response(null, { status: 304, headers })
    return new Response(svg, { headers: { ...headers, 'content-type': 'image/svg+xml' } })
  })

  app.put('/me/avatar', async (c) => {
    const principal = principalOf(c)
    const { seed } = await readBody<SetAvatarInput>(c, setAvatarSchema)
    const user =
      principal.provider === 'users' ? await deps.store.users.getUser(principal.id) : undefined
    if (!user)
      throw new HTTPException(409, { message: 'avatar seeds can only be set for user accounts' })
    const { avatarSeed: previous, ...rest } = user
    await deps.store.users.putUser(seed === null ? rest : { ...rest, avatarSeed: seed })
    c.set('audit', {
      action: 'user.avatar',
      target: { type: 'user', id: user.id },
      changes: [
        {
          field: 'avatarSeed',
          ...(previous !== undefined && { before: previous }),
          ...(seed !== null && { after: seed }),
        },
      ],
    })
    return c.json<MePrincipal | null>(await withAvatar(deps, principal))
  })

  return app
}
