import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import type { Env } from '../src/context.ts'
import { serveWeb } from '../src/web.ts'

test('serves build files and falls back to index.html for routes named like build folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holtkeeper-web-'))
  try {
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'index.html'), '<!doctype html>app')
    await writeFile(join(root, 'assets', 'main.js'), 'js')
    const app = new Hono<Env>()
    expect(await serveWeb(app, root)).toBe(true)

    const file = await app.request('/assets/main.js')
    expect(await file.text()).toBe('js')
    expect(file.headers.get('cache-control')).toContain('immutable')

    for (const path of ['/assets', '/assets?repo=gitlab:web', '/bundles']) {
      const page = await app.request(path)
      expect(await page.text()).toBe('<!doctype html>app')
      expect(page.headers.get('content-type')).toContain('text/html')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
