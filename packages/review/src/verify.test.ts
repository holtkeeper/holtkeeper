import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'

import { fakeAgent } from '../test/fakes.ts'
import type { ReviewUsage } from './schema.ts'
import type { Candidate } from './validate.ts'
import { existingEvidence, verifyFindings, verifyTurns } from './verify.ts'

const usage = (): ReviewUsage => ({ turns: 0 })
const candidate = (
  title: string,
  severity: Candidate['severity'],
  source = 'agent',
): Candidate => ({
  path: 'src/widget.ts',
  line: 3,
  severity,
  category: 'bug',
  title,
  body: 'b',
  source,
})
const mergeRequest = { title: 'Add widgets', description: '' }

describe('verifyFindings', () => {
  test('drops refuted findings, keeps confirmed, uncertain and unanswered ones', async () => {
    const { agent, tasks } = fakeAgent({
      'review-verify': [
        {
          findings: [
            { id: 0, verdict: 'refuted', reason: 'Guarded in src/widget.ts:2.' },
            { id: 1, verdict: 'uncertain', reason: '?' },
          ],
        },
      ],
    })
    const candidates = [
      candidate('A', 'minor'),
      candidate('B', 'minor'),
      candidate('C', 'info'),
      candidate('Check', 'minor', 'testids'),
    ]
    const result = await verifyFindings({
      agent,
      dir: '/checkout',
      candidates,
      usage: usage(),
      mergeRequest,
    })
    expect(result.kept.map((c) => c.title)).toEqual(['B', 'C', 'Check'])
    expect(result.refuted).toEqual([
      { candidate: candidates[0] as Candidate, reason: 'Guarded in src/widget.ts:2.' },
    ])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ taskKind: 'review-verify', tier: 'main', maxTurns: 22 })
    expect(tasks[0]?.prompt).not.toContain('Check')
  })

  test('serious findings are checked on deep, the rest on main or deep with deep', async () => {
    const { agent, tasks } = fakeAgent({})
    await verifyFindings({
      agent,
      dir: '/checkout',
      candidates: [candidate('A', 'critical'), candidate('B', 'minor')],
      usage: usage(),
      mergeRequest,
      deep: true,
    })
    expect(tasks.map((t) => t.tier)).toEqual(['deep', 'deep'])
  })

  test('nothing from the agent means no task', async () => {
    const { agent, tasks } = fakeAgent({})
    const result = await verifyFindings({
      agent,
      dir: '/checkout',
      candidates: [candidate('Check', 'major', 'gitleaks')],
      usage: usage(),
      mergeRequest,
    })
    expect(tasks).toHaveLength(0)
    expect(result.kept).toHaveLength(1)
  })

  test('a failed task keeps its findings, an abort is rethrown', async () => {
    const failing: Agent = {
      name: 'failing',
      run: async () => {
        throw new Error('model unavailable')
      },
    }
    const logged: string[] = []
    const result = await verifyFindings({
      agent: failing,
      dir: '/checkout',
      candidates: [candidate('A', 'major')],
      usage: usage(),
      mergeRequest,
      log: (line) => logged.push(line),
    })
    expect(result).toMatchObject({ refuted: [], failed: 1 })
    expect(result.kept).toHaveLength(1)
    expect(logged[0]).toContain('model unavailable')
    const controller = new AbortController()
    controller.abort()
    expect(
      verifyFindings({
        agent: failing,
        dir: '/checkout',
        candidates: [candidate('A', 'major')],
        usage: usage(),
        mergeRequest,
        signal: controller.signal,
      }),
    ).rejects.toThrow()
  })

  test('turns grow with the findings, up to 50', () => {
    expect(verifyTurns(1)).toBe(14)
    expect(verifyTurns(20)).toBe(50)
  })
})

describe('existingEvidence', () => {
  test('keeps cited files of the checkout only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evidence-'))
    try {
      await mkdir(join(dir, 'src'))
      await writeFile(join(dir, 'src/widget.ts'), 'export const widget = 1\n')
      expect(
        await existingEvidence(dir, [
          { path: 'src/widget.ts', line: 1 },
          { path: './src/widget.ts' },
          { path: 'src/missing.ts' },
          { path: '../outside.ts' },
          { path: '/etc/hosts' },
        ]),
      ).toEqual([{ path: 'src/widget.ts', line: 1 }, { path: './src/widget.ts' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
