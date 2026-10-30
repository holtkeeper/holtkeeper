import { join, normalize } from 'node:path'

import type { Hono } from 'hono'

import type { Env } from './context.ts'

/**
 * Serves the built web UI from `root`, falling back to `index.html` for client-side routes.
 * Does nothing when the UI has not been built.
 */
export async function serveWeb(app: Hono<Env>, root: string): Promise<boolean> {
  const index = Bun.file(join(root, 'index.html'))
  if (!(await index.exists())) return false

  app.get('*', async (c) => {
    const path = normalize(c.req.path).replace(/^(\.\.[/\\])+/, '')
    const file = Bun.file(join(root, path))
    if (path !== '/' && (await file.exists())) {
      const immutable = path.startsWith('/assets/')
      return new Response(file, {
        headers: {
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      })
    }
    return new Response(index, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  })
  return true
}
