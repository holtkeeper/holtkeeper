import { expect, test } from 'bun:test'

import { artifactId, memoryArtifactStore } from '@holtkeeper/artifacts'

import { persistArtifactsTo } from '../src/jobs.ts'

test('run artifacts are stored tagged with their analysis and must match their content', async () => {
  const store = memoryArtifactStore()
  const persist = persistArtifactsTo(store)
  const data = new Uint8Array([1, 2, 3])
  const context = { repo: { forge: 'work', path: 'web/site' }, kind: 'assets', analysisId: 'an-1' }
  await persist(
    [{ id: artifactId(data), data, contentType: 'image/webp', name: 'public/a.webp' }],
    context,
  )
  expect(await store.stat(artifactId(data))).toMatchObject({
    bytes: 3,
    contentType: 'image/webp',
    name: 'public/a.webp',
    tags: { repo: 'work:web/site', kind: 'assets', analysis: 'an-1' },
  })
  const failure = await persist([{ id: 'f'.repeat(64), data }], context).then(
    () => undefined,
    (error: unknown) => String(error),
  )
  expect(failure).toContain('does not match')
})
