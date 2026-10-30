import type { ArtifactZipInput } from '@holtkeeper/api'
import { isArtifactId, safeArchivePath, zipArtifacts } from '@holtkeeper/artifacts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, artifactsOf, principalOf, readBody } from '../context.ts'

const zipSchema = z.object({
  files: z
    .array(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/), path: z.string().min(1) }))
    .min(1)
    .max(500),
  name: z.string().min(1).max(200).optional(),
}) satisfies z.ZodType<ArtifactZipInput>

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** `attachment` disposition with an ASCII fallback and the UTF-8 name. */
function attachment(filename: string): string {
  const base = filename.split('/').at(-1) || 'download'
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`
}

/** Headers of every download: never rendered by the browser on our origin. */
export const downloadHeaders = (contentType: string, filename: string) => ({
  'content-type': contentType,
  'content-disposition': attachment(filename),
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'private, max-age=3600',
})

/** Largest archive `POST /api/artifacts/zip` builds in memory. */
const maxZipBytes = 512 * 1024 * 1024

/**
 * Downloads of stored artifacts. Ids are content hashes that only reach people through analyses
 * and media results, so being signed in is enough.
 */
export function artifactRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  app.get('/artifacts/:id', async (c) => {
    principalOf(c)
    const store = artifactsOf(deps)
    const id = c.req.param('id')
    const info = isArtifactId(id) ? await store.stat(id) : undefined
    if (!info) throw new HTTPException(404, { message: 'artifact not found' })
    const filename = info.name ?? id
    if (store.presign) {
      const url = await store.presign(id, {
        expiresIn: 300,
        filename: filename.split('/').at(-1) ?? id,
      })
      if (url) return c.redirect(url, 302)
    }
    const opened = await store.open(id)
    if (!opened) throw new HTTPException(404, { message: 'artifact not found' })
    return new Response(opened.body, {
      headers: {
        ...downloadHeaders(info.contentType, filename),
        'content-length': String(info.bytes),
        etag: `"${id}"`,
      },
    })
  })

  app.post('/artifacts/zip', async (c) => {
    principalOf(c)
    const store = artifactsOf(deps)
    const input = await readBody(c, zipSchema)
    const entries: { path: string; data: Uint8Array }[] = []
    let total = 0
    for (const { id, path } of input.files) {
      try {
        safeArchivePath(path)
      } catch (error) {
        throw new HTTPException(400, { message: messageOf(error) })
      }
      const artifact = await store.get(id)
      if (!artifact) throw new HTTPException(404, { message: `artifact ${id} not found` })
      total += artifact.bytes
      if (total > maxZipBytes) throw new HTTPException(413, { message: 'archive too large' })
      entries.push({ path, data: artifact.data })
    }
    let zip: Uint8Array
    try {
      zip = zipArtifacts(entries)
    } catch (error) {
      throw new HTTPException(400, { message: messageOf(error) })
    }
    return new Response(zip, {
      headers: downloadHeaders('application/zip', input.name ?? 'artifacts.zip'),
    })
  })

  return app
}
