import { describe, expect, test } from 'bun:test'

import type { BranchPushedEvent, DiffFile } from '@holtkeeper/forge'

import {
  defaultBranchOf,
  isDependencyFile,
  pushChangesDependencies,
} from '../src/dependency-refresh.ts'

const event = (extra: Partial<BranchPushedEvent> = {}): BranchPushedEvent => ({
  kind: 'push',
  repo: { forge: 'work', path: 'games/a' },
  branch: 'main',
  sha: 'c'.repeat(40),
  actor: '',
  ...extra,
})

const diff = (path: string, oldPath = path): DiffFile => ({
  oldPath,
  newPath: path,
  status: 'modified',
  diff: '',
})

describe('isDependencyFile', () => {
  test('matches manifests and lockfiles at any depth', () => {
    expect(isDependencyFile('package.json')).toBe(true)
    expect(isDependencyFile('apps/web/pnpm-lock.yaml')).toBe(true)
    expect(isDependencyFile('services/api/go.sum')).toBe(true)
    expect(isDependencyFile('docs/package.json.md')).toBe(false)
    expect(isDependencyFile('src/go.mod.ts')).toBe(false)
  })
})

describe('pushChangesDependencies', () => {
  test('reads the paths the event lists first', async () => {
    expect(await pushChangesDependencies(event({ files: ['a.ts', 'bun.lock'] }), undefined)).toBe(
      true,
    )
    expect(await pushChangesDependencies(event({ files: ['a.ts'] }), undefined)).toBe(false)
  })

  test('compares the commits through the forge, renames included', async () => {
    const compared: string[] = []
    const forge = {
      async compareCommits(repo: string, from: string, to: string) {
        compared.push(`${repo} ${from[0]}..${to[0]}`)
        return [diff('src/a.ts'), diff('packages/x/package.json', 'packages/old/package.json')]
      },
    }
    expect(await pushChangesDependencies(event({ before: 'b'.repeat(40) }), forge)).toBe(true)
    expect(compared).toEqual(['games/a b..c'])
  })

  test('cannot tell for a new branch, a forge without comparison or a failed one', async () => {
    expect(
      await pushChangesDependencies(event(), { compareCommits: async () => [] }),
    ).toBeUndefined()
    expect(await pushChangesDependencies(event({ before: 'b' }), {})).toBeUndefined()
    const failing = {
      async compareCommits(): Promise<DiffFile[]> {
        throw new Error('gone')
      },
    }
    expect(await pushChangesDependencies(event({ before: 'b' }), failing)).toBeUndefined()
  })
})

describe('defaultBranchOf', () => {
  test('takes the event value, else asks the forge, else gives up', async () => {
    expect(await defaultBranchOf(event({ defaultBranch: 'trunk' }), undefined)).toBe('trunk')
    const forge = {
      getRepository: async () => ({ path: 'games/a', defaultBranch: 'main' }) as never,
    }
    expect(await defaultBranchOf(event(), forge)).toBe('main')
    const failing = {
      getRepository: async (): Promise<never> => {
        throw new Error('down')
      },
    }
    expect(await defaultBranchOf(event(), failing)).toBeUndefined()
  })
})
