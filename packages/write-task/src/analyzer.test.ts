import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { GitForge } from '@holtkeeper/forge'

import { createWriteTaskAnalyzer, writeTaskAnalysis, writeTaskAnalyzer } from './analyzer.ts'
import { WRITE_POOL, writeTaskOptionsSchema } from './schema.ts'

const { runner } = createFakeRunner()
const forge = { getRepository: async () => ({ defaultBranch: 'main' }) } as unknown as GitForge
const options = writeTaskOptionsSchema.parse({
  taskId: 'ab12cd',
  title: 'Rename the widget prop',
  prompt: 'Rename size to scale.',
})

describe('write task analyzer', () => {
  test('runs only on the write pool, alone on its repository, never on its own', () => {
    expect(writeTaskAnalyzer).toMatchObject({ pool: WRITE_POOL, scope: 'repo' })
    expect(writeTaskAnalyzer.exclusive).toBeFalsy()
    expect(writeTaskAnalyzer.refresh).toBeUndefined()
  })

  test('the registry copy refuses every task before checking anything out', async () => {
    let checkouts = 0
    expect(
      writeTaskAnalyzer.run({
        repo: { forge: 'work', path: 'shapes/a' },
        runner,
        forge,
        options,
        checkout: async () => {
          checkouts++
          throw new Error('unexpected checkout')
        },
      }),
    ).rejects.toThrow('turned off')
    expect(checkouts).toBe(0)
  })

  test('asks the policy for the repository it runs on', async () => {
    const asked: string[] = []
    const analyzer = createWriteTaskAnalyzer({
      policy: async (repo) => {
        asked.push(repo.path)
        return { enabled: true, readOnly: true }
      },
    })
    expect(
      analyzer.run({
        repo: { forge: 'work', path: 'shapes/b' },
        runner,
        forge,
        options,
        checkout: async () => {
          throw new Error('unexpected checkout')
        },
      }),
    ).rejects.toThrow('read-only')
    await Bun.sleep(0)
    expect(asked).toEqual(['shapes/b'])
  })

  test('reports the merge request and failing checks', () => {
    const metrics = writeTaskAnalysis.summarize({
      taskId: 'ab12cd',
      title: 'Rename the widget prop',
      kind: 'change',
      status: 'opened',
      branch: 'holtkeeper/ab12cd-rename-the-widget-prop',
      targetBranch: 'main',
      path: 'agent',
      files: ['widget.ts'],
      checks: [
        {
          name: 'test',
          command: 'bun run test',
          ok: false,
          exitCode: 1,
          output: '',
          durationMs: 5,
        },
      ],
      mergeRequest: { id: 7, url: 'https://forge.test/mr/7', draft: true },
      agent: { summary: 'Renamed.', changes: [], remainingProblems: [], turns: 2, costUsd: 0.31 },
    })
    expect(metrics.map((metric) => [metric.id, metric.value])).toEqual([
      ['status', 'draft MR'],
      ['files', 1],
      ['checks', 1],
      ['cost', '$0.31'],
    ])
  })
})
