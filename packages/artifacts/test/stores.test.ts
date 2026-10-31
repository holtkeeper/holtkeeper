import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ArtifactStore,
  type StoreOptions,
  artifactCache,
  artifactId,
  artifactStorage,
  fsArtifactStore,
  memoryArtifactStore,
  s3ArtifactStore,
} from '../src/index.ts'
import { startFakeS3 } from './fake-s3.ts'

const text = (value: string) => new TextEncoder().encode(value)

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

let s3: ReturnType<typeof startFakeS3>
const dirs: string[] = []
beforeAll(() => {
  s3 = startFakeS3('bucket')
})
afterAll(async () => {
  await s3.stop()
})
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  s3.objects.clear()
})

const stores: [string, (options: StoreOptions) => Promise<ArtifactStore>][] = [
  ['memory', async (options) => memoryArtifactStore(options)],
  [
    'fs',
    async (options) => {
      const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-artifacts-'))
      dirs.push(dir)
      return fsArtifactStore({ dir, ...options })
    },
  ],
  [
    's3',
    async (options) =>
      s3ArtifactStore({
        bucket: 'bucket',
        endpoint: s3.endpoint,
        region: 'us-east-1',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        prefix: 'hk/artifacts',
        usageCacheMs: 0,
        ...options,
      }),
  ],
]

for (const [name, create] of stores) {
  describe(`${name} store`, () => {
    test('answers ping while reachable', async () => {
      expect(await failure((await create({})).ping())).toBe('resolved')
    })

    test('stores content under its sha256 and merges metadata of repeated puts', async () => {
      let now = new Date('2026-10-01T00:00:00Z')
      const store = await create({ now: () => now })
      const data = text('hello')
      const stored = await store.put(data, {
        contentType: 'text/plain',
        name: 'a/hello.txt',
        tags: { repo: 'work:games/a' },
      })
      expect(stored).toEqual({ id: artifactId(data), bytes: 5 })
      now = new Date('2026-10-02T00:00:00Z')
      await store.put(data, { tags: { kind: 'media' } })
      const artifact = await store.get(stored.id)
      expect(artifact).toMatchObject({
        contentType: 'text/plain',
        name: 'a/hello.txt',
        createdAt: '2026-10-01T00:00:00.000Z',
        lastAccessedAt: '2026-10-02T00:00:00.000Z',
        tags: { repo: 'work:games/a', kind: 'media' },
      })
      expect(new TextDecoder().decode(artifact?.data)).toBe('hello')
      const opened = await store.open(stored.id)
      expect(await new Response(opened?.body).text()).toBe('hello')
      expect(await store.has(stored.id)).toBe(true)
      expect(await store.get('../../etc/passwd')).toBeUndefined()
      expect(await store.get('0'.repeat(64))).toBeUndefined()
      expect(await store.delete(stored.id)).toBe(true)
      expect(await store.delete(stored.id)).toBe(false)
      expect(await store.has(stored.id)).toBe(false)
    })

    test('lists pages, reports usage and sweeps by age and size', async () => {
      let now = new Date('2026-10-01T00:00:00Z')
      const store = await create({ now: () => now, touchIntervalMs: 0 })
      const ids: string[] = []
      for (const [i, type] of ['image/webp', 'image/webp', 'image/avif'].entries()) {
        now = new Date(`2026-10-0${i + 1}T00:00:00Z`)
        ids.push(
          (await store.put(text(`file-${i}`), { contentType: type, tags: { repo: `r${i % 2}` } }))
            .id,
        )
      }
      const first = await store.list({ limit: 2 })
      expect(first.items).toHaveLength(2)
      const second = await store.list({
        limit: 2,
        ...(first.cursor ? { cursor: first.cursor } : {}),
      })
      expect(second.cursor).toBeUndefined()
      expect([...first.items, ...second.items].map((i) => i.id)).toEqual(ids.toSorted())

      expect(await store.usage()).toEqual({
        count: 3,
        bytes: 18,
        byContentType: {
          'image/webp': { count: 2, bytes: 12 },
          'image/avif': { count: 1, bytes: 6 },
        },
        byTag: { repo: { r0: { count: 2, bytes: 12 }, r1: { count: 1, bytes: 6 } } },
      })

      expect(await store.sweep({ olderThan: new Date('2026-10-02T00:00:00Z') })).toEqual({
        removed: 1,
        bytes: 6,
      })
      expect(await store.has(ids[0] ?? '')).toBe(false)
      expect(await store.sweep({ maxBytes: 6 })).toEqual({ removed: 1, bytes: 6 })
      expect(await store.has(ids[1] ?? '')).toBe(false)
      expect(await store.has(ids[2] ?? '')).toBe(true)
    })

    test('points refs at stored artifacts and drops them with their target', async () => {
      const store = await create({ now: () => new Date('2026-10-01T00:00:00Z') })
      const { id } = await store.put(text('variant'))
      expect(
        await store.setRef('cache/media/abc/avif-640w', { id, meta: { width: 640, ok: true } }),
      ).toEqual({ id, meta: { width: 640, ok: true }, updatedAt: '2026-10-01T00:00:00.000Z' })
      expect(await store.getRef('cache/media/abc/avif-640w')).toMatchObject({ id })
      expect(await store.getRef('cache/missing')).toBeUndefined()
      expect(await store.getRef('../etc/passwd')).toBeUndefined()
      expect(await failure(store.setRef('a/../b', { id }))).toContain('malformed')
      expect(await failure(store.setRef('a', { id: 'f'.repeat(64) }))).toContain('not stored')
      expect((await store.list()).items.map((item) => item.id)).toEqual([id])
      await store.delete(id)
      expect(await store.getRef('cache/media/abc/avif-640w')).toBeUndefined()
      expect(await store.deleteRef('cache/media/abc/avif-640w')).toBe(true)
      expect(await store.deleteRef('cache/media/abc/avif-640w')).toBe(false)
    })

    test('caches blobs by key through refs', async () => {
      const store = await create({})
      const cache = artifactCache(store, { namespace: 'test' })
      expect(await cache.get('k')).toBeUndefined()
      await cache.set('k', text('one'), { meta: { quality: 55 }, contentType: 'image/avif' })
      await cache.set('with spaces?', text('two'))
      const hit = await cache.get('k')
      expect(new TextDecoder().decode(hit?.data)).toBe('one')
      expect(hit?.meta).toEqual({ quality: 55 })
      expect(new TextDecoder().decode((await cache.get('with spaces?'))?.data)).toBe('two')
      expect((await store.usage()).byTag).toEqual({
        kind: { cache: { count: 2, bytes: 6 } },
      })
    })

    test('clears through the storage provider by tag', async () => {
      const store = await create({})
      await store.put(text('a'), { contentType: 'image/png', tags: { repo: 'x' } })
      await store.put(text('b'), { contentType: 'image/png', tags: { repo: 'y' } })
      const provider = artifactStorage(store)
      expect((await provider.usage()).details).toEqual([
        { label: 'image/png', bytes: 2, count: 2 },
        { label: 'repo x', bytes: 1, count: 1 },
        { label: 'repo y', bytes: 1, count: 1 },
      ])
      expect(await provider.clear?.('repo=x')).toEqual({ removed: 1, bytes: 1 })
      expect((await store.usage()).count).toBe(1)
    })
  })
}

test('fs store fans content out in two levels with a sidecar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-artifacts-'))
  dirs.push(dir)
  const { id } = await fsArtifactStore({ dir }).put(text('x'))
  expect((await readdir(join(dir, id.slice(0, 2), id.slice(2, 4)))).toSorted()).toEqual([
    id,
    `${id}.json`,
  ])
})

test('s3 ping is one listing request however many artifacts there are', async () => {
  const store = s3ArtifactStore({
    bucket: 'bucket',
    endpoint: s3.endpoint,
    region: 'us-east-1',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    prefix: 'hk',
  })
  await Promise.all([1, 2, 3].map((n) => store.put(text(`artifact ${n}`))))
  s3.requests.length = 0
  await store.ping()
  expect(s3.requests).toHaveLength(1)
  expect(s3.requests[0]).toStartWith('GET /bucket')
  expect(s3.requests[0]).toContain('max-keys=1')
})

test('s3 store uses the prefix and presigns downloads', async () => {
  const store = s3ArtifactStore({
    bucket: 'bucket',
    endpoint: s3.endpoint,
    region: 'us-east-1',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    prefix: 'hk/',
  })
  const { id } = await store.put(text('x'), { contentType: 'image/png', name: 'img/a.png' })
  expect([...s3.objects.keys()].toSorted()).toEqual([
    `hk/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`,
    `hk/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.json`,
  ])
  const url = await store.presign?.(id, { expiresIn: 60 })
  expect(url).toContain(`/bucket/hk/${id.slice(0, 2)}/`)
  expect(url).toContain('X-Amz-Expires=60')
  expect(await store.presign?.('f'.repeat(64))).toBeUndefined()
})
