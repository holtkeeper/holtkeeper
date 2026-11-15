import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { entry } from '../test/entries.ts'
import {
  type RepositoryState,
  evidenceCommits,
  evidencePaths,
  freshnessSignals,
  readFreshness,
  writeFreshness,
} from './freshness.ts'

const base = entry({ id: 'e1', title: 'Use the widget loader', body: 'Load widgets lazily.' })

const state = (extra: Partial<RepositoryState> = {}): RepositoryState => ({
  files: new Set(['src/loader.ts', 'docs/guide/a.md']),
  dependencies: new Set(['npm:widget']),
  now: new Date('2026-02-01T00:00:00.000Z'),
  ...extra,
})

describe('evidencePaths', () => {
  test('reads files and folders of this repository from forge links only', () => {
    const paths = evidencePaths(
      {
        evidence: [
          { label: 'a', url: 'https://git.example/acme/web/-/blob/abc123/src/loader.ts#L10' },
          { label: 'b', url: 'https://github.com/acme/web/tree/main/docs/guide' },
          { label: 'c', url: 'https://git.example/acme/web/-/merge_requests/7' },
          { label: 'd', url: 'https://git.example/acme/other/-/blob/abc123/x.ts' },
          { label: 'e', url: 'https://git.example/x/acme/web/-/blob/abc123/nested.ts' },
          { label: 'f', url: 'not a url' },
        ],
      },
      'acme/web',
    )
    expect(paths).toEqual(['docs/guide', 'src/loader.ts'])
  })
})

const withEvidence = (path: string) =>
  entry({
    ...base,
    evidence: [{ label: 'f', url: `https://git.example/acme/web/-/blob/abc/${path}` }],
  })
const run = (e = base, s = state(), checkedAt?: string) =>
  freshnessSignals({
    entry: e,
    repoPath: 'acme/web',
    state: s,
    ...(checkedAt && { judgedAt: checkedAt }),
  })

describe('freshnessSignals', () => {
  test('nothing moved: no signals', () => {
    expect(run(withEvidence('src/loader.ts'), state(), '2026-01-30T00:00:00.000Z')).toEqual([])
  })

  test('an evidence file that is gone, or a folder that still exists', () => {
    expect(run(withEvidence('src/gone.ts'), state(), '2026-01-30T00:00:00.000Z')).toEqual([
      { kind: 'missing-file', detail: 'src/gone.ts' },
    ])
    expect(run(withEvidence('docs/guide'), state(), '2026-01-30T00:00:00.000Z')).toEqual([])
  })

  test('changed evidence files and match globs', () => {
    const e = entry({ ...withEvidence('src/loader.ts'), match: { files: ['docs/**'] } })
    const signals = run(
      e,
      state({ changed: new Set(['src/loader.ts', 'docs/guide/a.md']) }),
      '2026-01-30T00:00:00.000Z',
    )
    expect(signals.map((s) => s.detail)).toEqual([
      'src/loader.ts',
      'docs/guide/a.md (matches docs/**)',
    ])
  })

  test('a package that is no longer a dependency; unknown dependencies say nothing', () => {
    const e = entry({ ...base, subject: 'npm:gone-lib' })
    const checked = '2026-01-30T00:00:00.000Z'
    expect(run(e, state(), checked)).toEqual([{ kind: 'package-gone', detail: 'npm:gone-lib' }])
    expect(run(e, state({ dependencies: new Set() }), checked)).toEqual([])
  })

  test('aged after 90 days since the last check, or since the update when never checked', () => {
    expect(run(base, state(), '2025-10-01T00:00:00.000Z')).toEqual([
      { kind: 'aged', detail: '90+ days' },
    ])
    expect(run(entry({ ...base, updatedAt: '2025-10-01T00:00:00.000Z' }), state())).toEqual([
      { kind: 'aged', detail: '90+ days' },
    ])
  })
})

describe('evidenceCommits', () => {
  test('keeps full commit shas of links into this repository', () => {
    const sha = 'a'.repeat(40)
    expect(
      evidenceCommits(
        {
          evidence: [
            { label: 'a', url: `https://git.example/acme/web/-/blob/${sha}/src/a.ts` },
            { label: 'b', url: 'https://git.example/acme/web/-/blob/main/src/b.ts' },
            { label: 'c', url: `https://git.example/x/acme/web/-/blob/${'b'.repeat(40)}/c.ts` },
          ],
        },
        'acme/web',
      ),
    ).toEqual([sha])
  })
})

describe('freshness storage', () => {
  test('round-trips and ignores invalid values', async () => {
    const { kv } = memoryStore()
    if (!kv) throw new Error('no kv')
    await writeFreshness(kv, 'e1', {
      status: 'fresh',
      checkedAt: '2026-01-01T00:00:00.000Z',
      method: 'signals',
      repo: 'work:acme/web',
      signals: [],
    })
    await kv.set('knowledge:fresh:e2', { nonsense: true })
    const read = await readFreshness(kv, ['e1', 'e2', 'e3'])
    expect([...read.keys()]).toEqual(['e1'])
    expect((await readFreshness(undefined, ['e1'])).size).toBe(0)
  })
})
