import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import {
  DIGEST_MIN_CHARS,
  DIGEST_VERSION,
  type RepoDigest,
  applyDigests,
  digestKey,
  digestedDocs,
  readRepoDigests,
  renderDigest,
} from './digest.ts'

const digest = (sha = 'sha1'): RepoDigest => ({
  version: DIGEST_VERSION,
  sha,
  groups: {
    general: [{ text: 'Run `make test` before pushing.', source: 'Testing' }],
    review: [{ text: 'Reject widgets without a label.' }],
    code: [{ text: 'Name widgets in PascalCase.', source: 'Style' }],
  },
  model: 'tier:fast',
  costUsd: 0.01,
  at: '2026-01-01T00:00:00.000Z',
})

const long = 'x'.repeat(DIGEST_MIN_CHARS + 500)

describe('renderDigest', () => {
  test('a review gets general and review lines with their sources', () => {
    const text = renderDigest(digest(), 'review', 'CONTRIBUTING.md')
    expect(text).toContain('- Run `make test` before pushing. (CONTRIBUTING.md § Testing)')
    expect(text).toContain('- Reject widgets without a label.')
    expect(text).not.toContain('PascalCase')
  })

  test('agent work gets general and code lines', () => {
    const text = renderDigest(digest(), 'agent', 'CONTRIBUTING.md')
    expect(text).toContain('PascalCase')
    expect(text).not.toContain('Reject widgets')
  })

  test('release notes get general lines only', () => {
    const text = renderDigest(digest(), 'release-notes', 'CONTRIBUTING.md')
    expect(text).toContain('make test')
    expect(text).not.toContain('PascalCase')
  })
})

describe('applyDigests', () => {
  test('replaces long files that have a digest, keeps the others', () => {
    const docs = [
      { file: 'CONTRIBUTING.md', text: long },
      { file: 'AGENTS.md', text: long },
      { file: 'REVIEW.md', text: 'short rules' },
    ]
    const out = applyDigests(
      docs,
      new Map([
        ['CONTRIBUTING.md', digest()],
        ['REVIEW.md', digest()],
      ]),
      'review',
    )
    expect(out[0]?.text).toContain('Condensed from CONTRIBUTING.md for review')
    expect(out[1]).toEqual(docs[1])
    expect(out[2]).toEqual(docs[2])
  })

  test('keeps the file when the digest has nothing for the task', () => {
    const empty: RepoDigest = { ...digest(), groups: { general: [], review: [], code: [] } }
    const docs = [{ file: 'CONTRIBUTING.md', text: long }]
    expect(applyDigests(docs, new Map([['CONTRIBUTING.md', empty]]), 'review')).toEqual(docs)
  })
})

describe('readRepoDigests and digestedDocs', () => {
  test('ignores digests of another version or another file sha', async () => {
    const { kv } = memoryStore()
    await kv?.set(digestKey('work', 'acme/web', 'A.md'), digest('new'))
    await kv?.set(digestKey('work', 'acme/web', 'B.md'), { ...digest('new'), version: 0 })
    const read = (shas?: Map<string, string>) =>
      readRepoDigests({
        kv: kv as NonNullable<typeof kv>,
        forgeId: 'work',
        repo: 'acme/web',
        files: ['A.md', 'B.md'],
        ...(shas && { shas }),
      })
    expect([...(await read()).keys()]).toEqual(['A.md'])
    expect((await read(new Map([['A.md', 'old']]))).size).toBe(0)
    expect((await read(new Map([['A.md', 'new']]))).size).toBe(1)
  })

  test('digestedDocs trusts the stored digest without a sha and survives no kv', async () => {
    const { kv } = memoryStore()
    await kv?.set(digestKey('work', 'acme/web', 'CONTRIBUTING.md'), digest())
    const docs = [{ file: 'CONTRIBUTING.md', text: long }]
    const base = { forgeId: 'work', repo: 'acme/web', task: 'review' as const, docs }
    const out = await digestedDocs({ ...base, kv })
    expect(out[0]?.text).toContain('Condensed from')
    expect(await digestedDocs({ ...base, kv: undefined })).toEqual(docs)
  })
})
