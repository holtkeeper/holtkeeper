import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  ApplyChangesResult,
  MediaApplyResult,
  MediaVariantsResult,
  StorageOverview,
} from '@holtkeeper/api'
import {
  type ArtifactStore,
  artifactId,
  artifactStorage,
  memoryArtifactStore,
  unzipArtifacts,
} from '@holtkeeper/artifacts'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import type { CodeChange } from '@holtkeeper/changes'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { CommitInput } from '@holtkeeper/forge'
import { defineAnalysis } from '@holtkeeper/report'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { MediaEngine } from '../src/media/engine.ts'
import { startArtifactRetention } from '../src/server.ts'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6])
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!-- c --></svg>'
const bytesOf = (text: string) => new TextEncoder().encode(text)

const repoFiles: Record<string, Uint8Array> = {}
const commits: CommitInput[] = []
const fakeForge = {
  kind: 'fake',
  getRepository: async () => ({ defaultBranch: 'main' }),
  readFile: async (_repo: string, file: string) => {
    const bytes = repoFiles[file]
    return bytes && new TextDecoder().decode(bytes)
  },
  readFileBytes: async (_repo: string, file: string) => repoFiles[file],
  commit: async (_repo: string, input: CommitInput) => {
    commits.push(input)
    return { sha: 'abc', webUrl: '' }
  },
  createMergeRequest: async () => ({ id: 9, webUrl: 'https://forge.test/mr/9' }),
}

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => fakeForge } },
  groups: { games: { forge: 'work', include: ['games/*'] } },
})

let engineCalls = 0
const fakeEngine: MediaEngine = {
  async variants({ data, options }) {
    engineCalls += 1
    return {
      original: { width: 100, height: 50, format: 'png', bytes: data.byteLength },
      variants: (options.widths ?? [100]).flatMap((width) =>
        (options.formats ?? ['webp']).map((format) => ({
          format,
          width,
          height: width / 2,
          quality: options.quality ?? 80,
          data: bytesOf(`${format}-${width}`),
          contentType: `image/${format}`,
        })),
      ),
    }
  },
  async optimizeSvg({ svg: text }) {
    const data = text.replace('<!-- c -->', '')
    return {
      data,
      before: text.length,
      after: data.length,
      breakdown: { comments: 10 },
      width: 10,
      height: 10,
    }
  },
  async snippets({ variants }) {
    return { html: `<picture>${variants.map((v) => v.path).join(',')}</picture>` }
  },
}

const binaryChange = (artifact: string, bytes: number): CodeChange => ({
  id: 'hero',
  title: 'Optimize hero',
  confidence: 'review',
  source: 'media',
  edits: [{ kind: 'write-binary', file: 'img/hero.webp', bytes, artifact }],
})

const imagesKind = defineAnalysis<{ change: CodeChange }>({
  kind: 'images',
  label: 'Images',
  changes: (data) => [data.change],
  schema: z.object({ change: z.custom<CodeChange>() }),
  summarize: () => [],
  toReport: (current) => ({
    kind: 'images',
    title: 'Images',
    generatedAt: current.createdAt,
    metrics: [],
    sections: [],
  }),
})

let store: Store
let artifacts: ArtifactStore
const setup = (auth: AuthProvider = noAuth(), extra: { artifacts?: ArtifactStore } = {}) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      activity: store.activity,
      vault,
    }),
    settings: builtinSettings,
    analyses: [imagesKind],
    artifacts: extra.artifacts ?? artifacts,
    media: fakeEngine,
    storage: [artifactStorage(extra.artifacts ?? artifacts)],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const post = (
  app: ReturnType<typeof setup>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  store = memoryStore()
  artifacts = memoryArtifactStore()
  commits.length = 0
  engineCalls = 0
  for (const key of Object.keys(repoFiles)) delete repoFiles[key]
  repoFiles['img/hero.png'] = png
  repoFiles['img/logo.svg'] = bytesOf(svg)
  repoFiles['src/page.html'] = bytesOf('<img src="img/hero.png">\n')
})

describe('artifacts', () => {
  test('downloads need a sign-in and come as attachments', async () => {
    const { id } = await artifacts.put(bytesOf('<svg/>'), {
      contentType: 'image/svg+xml',
      name: 'img/ünï.svg',
    })
    const anonymous = setup(headerAuth())
    expect((await anonymous.request(`/api/artifacts/${id}`)).status).toBe(401)
    const response = await setup().request(`/api/artifacts/${id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="_n_.svg"; filename*=UTF-8''%C3%BCn%C3%AF.svg`,
    )
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(await response.text()).toBe('<svg/>')
    expect((await setup().request(`/api/artifacts/${'0'.repeat(64)}`)).status).toBe(404)
    expect(
      (await setup(noAuth(), { artifacts: undefined as never }).request('/api/artifacts/x')).status,
    ).toBe(404)
  })

  test('redirects to a presigned URL when the store has one', async () => {
    const { id } = await artifacts.put(bytesOf('x'))
    const presigned: ArtifactStore = {
      ...artifacts,
      presign: async (key) => `https://bucket.test/${key}?sig=1`,
    }
    const response = await setup(noAuth(), { artifacts: presigned }).request(`/api/artifacts/${id}`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`https://bucket.test/${id}?sig=1`)
  })

  test('zips several artifacts', async () => {
    const a = await artifacts.put(bytesOf('a'))
    const b = await artifacts.put(bytesOf('b'))
    const response = await post(setup(), '/api/artifacts/zip', {
      files: [
        { id: a.id, path: 'one/a.txt' },
        { id: b.id, path: 'b.txt' },
      ],
    })
    expect(response.headers.get('content-type')).toBe('application/zip')
    const files = unzipArtifacts(new Uint8Array(await response.arrayBuffer()))
    expect(Object.keys(files).toSorted()).toEqual(['b.txt', 'one/a.txt'])
    expect(
      (await post(setup(), '/api/artifacts/zip', { files: [{ id: a.id, path: '../a' }] })).status,
    ).toBe(400)
  })
})

describe('media variants', () => {
  test('stores variants as artifacts and caches by content and options', async () => {
    const app = setup()
    const body = {
      repo: 'work:games/a',
      file: 'img/hero.png',
      formats: ['webp', 'avif'],
      widths: [100, 50],
    }
    const result = (await (
      await post(app, '/api/media/variants', body)
    ).json()) as MediaVariantsResult
    expect(result.original).toEqual({
      width: 100,
      height: 50,
      format: 'png',
      bytes: 10,
      sha256: artifactId(png),
    })
    expect(result.variants.map((v) => [v.format, v.width, v.path, v.bytes])).toEqual([
      ['webp', 100, 'img/hero-100w.webp', 8],
      ['avif', 100, 'img/hero-100w.avif', 8],
      ['webp', 50, 'img/hero-50w.webp', 7],
      ['avif', 50, 'img/hero-50w.avif', 7],
    ])
    expect(result.variants[0]?.savingsPercent).toBe(20)
    expect(result.savings).toMatchObject({ originalBytes: 10, bestSavingsPercent: 20 })
    expect(result.snippets.html).toContain('img/hero-50w.avif')
    const stored = await artifacts.get(result.variants[0]?.id ?? '')
    expect(stored).toMatchObject({
      contentType: 'image/webp',
      tags: { repo: 'work:games/a', kind: 'media' },
    })

    await post(app, '/api/media/variants', body)
    expect(engineCalls).toBe(1)
    await post(app, '/api/media/variants', { ...body, quality: 50 })
    expect(engineCalls).toBe(2)
  })

  test('optimizes SVGs and checks access and existence', async () => {
    const app = setup()
    const result = (await (
      await post(app, '/api/media/variants', { repo: 'work:games/a', file: 'img/logo.svg' })
    ).json()) as MediaVariantsResult
    expect(result.svg).toMatchObject({ before: svg.length, breakdown: { comments: 10 } })
    expect(
      new TextDecoder().decode((await artifacts.get(result.svg?.id ?? ''))?.data),
    ).not.toContain('<!--')
    expect(
      (await post(app, '/api/media/variants', { repo: 'work:games/a', file: 'nope.png' })).status,
    ).toBe(404)
    expect(
      (await post(app, '/api/media/variants', { repo: 'games/a', file: 'a.png' })).status,
    ).toBe(400)
    const games = headerAuth({
      roles: { viewers: [{ scope: { groups: ['other'] }, actions: ['analyses:read'] }] },
    })
    const denied = await post(
      setup(games),
      '/api/media/variants',
      { repo: 'work:games/a', file: 'img/hero.png' },
      { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'viewers' },
    )
    expect(denied.status).toBe(403)
  })
})

const variantsOf = async (app: ReturnType<typeof setup>) =>
  (await (
    await post(app, '/api/media/variants', {
      repo: 'work:games/a',
      file: 'img/hero.png',
      widths: [100],
    })
  ).json()) as MediaVariantsResult

describe('media apply', () => {
  test('opens a merge request with binary files and the markup change', async () => {
    const app = setup()
    const { variants } = await variantsOf(app)
    const id = variants[0]?.id ?? ''
    const response = await post(app, '/api/media/apply', {
      repo: 'work:games/a',
      file: 'img/hero.png',
      variants: [id],
      paths: { [id]: 'img/opt/hero.webp' },
      snippet: {
        file: 'src/page.html',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 25 } },
        oldText: '<img src="img/hero.png">',
        newText: '<picture></picture>',
      },
      mode: 'merge-request',
    })
    const result = (await response.json()) as MediaApplyResult
    expect(result).toEqual({
      applied: true,
      conflicts: [],
      mergeRequest: { id: 9, url: 'https://forge.test/mr/9' },
    })
    expect(commits[0]?.changes).toEqual([
      {
        action: 'create',
        path: 'img/opt/hero.webp',
        content: Buffer.from('webp-100').toString('base64'),
        encoding: 'base64',
      },
      { action: 'update', path: 'src/page.html', content: '<picture></picture>\n' },
    ])
    expect((await store.activity.list({ limit: 5 }))[0]?.action).toBe('media.merge_request_opened')
  })

  test('replaces the original only while it is unchanged', async () => {
    const app = setup()
    const { svg: optimized } = (await (
      await post(app, '/api/media/variants', { repo: 'work:games/a', file: 'img/logo.svg' })
    ).json()) as MediaVariantsResult
    const input = {
      repo: 'work:games/a',
      file: 'img/logo.svg',
      variants: [],
      replaceOriginal: optimized?.id,
      mode: 'merge-request',
    }
    const ok = (await (await post(app, '/api/media/apply', input)).json()) as MediaApplyResult
    expect(ok.applied).toBe(true)
    expect(commits[0]?.changes[0]).toMatchObject({
      action: 'update',
      path: 'img/logo.svg',
      encoding: 'base64',
    })
  })

  test('returns a zip with the files and a README', async () => {
    const app = setup()
    const { variants } = await variantsOf(app)
    const response = await post(app, '/api/media/apply', {
      repo: 'work:games/a',
      file: 'img/hero.png',
      variants: variants.map((v) => v.id),
      snippet: {
        file: 'src/page.html',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 25 } },
        oldText: '<img src="img/hero.png">',
        newText: '<picture></picture>',
      },
      mode: 'zip',
    })
    expect(response.headers.get('content-disposition')).toContain('hero-media.zip')
    const files = unzipArtifacts(new Uint8Array(await response.arrayBuffer()))
    expect(Object.keys(files).toSorted()).toEqual(['README.md', 'img/hero-100w.webp'])
    expect(new TextDecoder().decode(files['README.md'])).toContain('<picture></picture>')
    expect(commits).toEqual([])
  })
})

describe('analyses with artifacts', () => {
  test('ingests verified artifacts and resolves them when changes are accepted', async () => {
    const app = setup()
    const webp = bytesOf('webp!')
    const id = artifactId(webp)
    const wrong = await post(app, '/api/analyses', {
      repo: { forge: 'work', path: 'games/a' },
      kind: 'images',
      data: { change: binaryChange(id, 5) },
      artifacts: [{ id, base64: Buffer.from('other').toString('base64') }],
    })
    expect(wrong.status).toBe(400)

    const created = await post(app, '/api/analyses', {
      repo: { forge: 'work', path: 'games/a' },
      kind: 'images',
      data: { change: binaryChange(id, 5) },
      artifacts: [{ id, base64: Buffer.from(webp).toString('base64'), contentType: 'image/webp' }],
    })
    expect(created.status).toBe(201)
    const { id: analysis } = (await created.json()) as { id: string }
    expect((await artifacts.stat(id))?.tags).toEqual({
      repo: 'work:games/a',
      kind: 'images',
      analysis,
    })

    const patch = (await (
      await post(app, `/api/analyses/${analysis}/changes`, { ids: ['hero'], mode: 'patch' })
    ).json()) as ApplyChangesResult
    expect(patch.applied).toEqual(['hero'])
    expect(patch.patch).toContain('#   img/hero.webp (5 bytes, new)')

    const merged = (await (
      await post(app, `/api/analyses/${analysis}/changes`, { ids: ['hero'], mode: 'merge-request' })
    ).json()) as ApplyChangesResult
    expect(merged.mergeRequest?.url).toBe('https://forge.test/mr/9')
    expect(commits[0]?.changes).toEqual([
      {
        action: 'create',
        path: 'img/hero.webp',
        content: Buffer.from(webp).toString('base64'),
        encoding: 'base64',
      },
    ])
  })
})

describe('storage', () => {
  test('reports usage per provider and clears with an activity event', async () => {
    await artifacts.put(bytesOf('abc'), {
      contentType: 'image/png',
      tags: { repo: 'work:games/a' },
    })
    const app = setup()
    const overview = (await (await app.request('/api/storage')).json()) as StorageOverview
    expect(overview.totalBytes).toBe(3)
    expect(overview.providers[0]).toMatchObject({
      id: 'artifacts',
      count: 1,
      clearable: true,
      available: true,
    })
    const cleared = await app.request('/api/storage/artifacts/clear', { method: 'POST' })
    expect(await cleared.json()).toEqual({ removed: 1, bytes: 3 })
    expect((await store.activity.list({ limit: 1 }))[0]).toMatchObject({
      action: 'storage.cleared',
      subject: 'artifacts',
    })
    expect((await app.request('/api/storage/nope/clear', { method: 'POST' })).status).toBe(404)
    expect((await setup(headerAuth()).request('/api/storage')).status).toBe(401)
  })
})

describe('artifact retention', () => {
  test('sweeps on start by age and size', async () => {
    let now = new Date('2026-10-01T00:00:00Z')
    const swept = memoryArtifactStore({ now: () => now, touchIntervalMs: 0 })
    await swept.put(bytesOf('old'))
    now = new Date('2026-10-29T00:00:00Z')
    await swept.put(bytesOf('new'))
    const lines: string[] = []
    const stop = startArtifactRetention(
      swept,
      { days: 7 },
      { now: () => now, log: (line) => lines.push(line) },
    )
    await Bun.sleep(5)
    stop()
    expect((await swept.usage()).count).toBe(1)
    expect(lines).toEqual(['artifacts: removed 1 (3 bytes)'])
    expect(startArtifactRetention(swept, undefined)).toBeFunction()
  })
})
