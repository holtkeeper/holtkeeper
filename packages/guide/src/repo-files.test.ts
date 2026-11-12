import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { blobSha, readRepoRuleFiles, repoDocsOf } from './repo-files.ts'

const forgeOf = (files: Record<string, string>, head?: string) => {
  const reads: string[] = []
  return {
    reads,
    forge: {
      readFile: async (_repo: string, file: string, ref?: string) => {
        reads.push(`${file}@${ref ?? ''}`)
        return files[file]
      },
      ...(head ? { headCommit: async () => head } : {}),
    },
  }
}

describe('readRepoRuleFiles', () => {
  test('reads existing non-blank files in order at the head and caches them by sha', async () => {
    const { kv } = memoryStore()
    const { forge, reads } = forgeOf(
      { 'AGENTS.md': 'Run bun test.\n', 'REVIEW.md': 'Flag raw widgets.', 'CLAUDE.md': '  ' },
      'abc123',
    )
    const input = {
      forge,
      forgeId: 'work',
      repo: 'games/app',
      files: ['REVIEW.md', 'CLAUDE.md', 'AGENTS.md'],
      kv,
    }
    const first = await readRepoRuleFiles(input)
    expect(first.sha).toBe('abc123')
    expect(first.files.map((file) => file.path)).toEqual(['REVIEW.md', 'AGENTS.md'])
    expect(first.files[1]).toEqual({
      path: 'AGENTS.md',
      sha: blobSha('Run bun test.\n'),
      text: 'Run bun test.',
    })
    expect(reads).toEqual(['REVIEW.md@abc123', 'CLAUDE.md@abc123', 'AGENTS.md@abc123'])
    expect(await readRepoRuleFiles(input)).toEqual(first)
    expect(reads).toHaveLength(3)
    expect(repoDocsOf(first.files)).toEqual([
      { file: 'REVIEW.md', text: 'Flag raw widgets.' },
      { file: 'AGENTS.md', text: 'Run bun test.' },
    ])
  })

  test('without a head sha it reads every time', async () => {
    const { kv } = memoryStore()
    const { forge, reads } = forgeOf({ 'AGENTS.md': 'x' })
    const input = { forge, forgeId: 'work', repo: 'games/app', files: ['AGENTS.md'], kv }
    await readRepoRuleFiles(input)
    const again = await readRepoRuleFiles(input)
    expect(again.sha).toBeUndefined()
    expect(reads).toHaveLength(2)
  })

  test('blobSha matches git', () => {
    expect(blobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })
})
