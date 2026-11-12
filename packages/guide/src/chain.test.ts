import { describe, expect, test } from 'bun:test'

import type { GuideSection } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { buildGuideChain, chainLayers, chainTaskOf } from './chain.ts'
import { createGuideResolver } from './load.ts'
import { resolveGuide } from './resolve.ts'

const repo = { forge: 'work', path: 'games/app', groups: ['games', 'web'] }

const row = (overrides: Partial<GuideSection>): GuideSection => ({
  scope: 'all',
  section: 'review',
  rules: '',
  steering: '',
  version: 0,
  learnings: [],
  ...overrides,
})

describe('chainLayers', () => {
  test('numbers layers in the order the agent reads them, several groups in config order', () => {
    const resolved = resolveGuide({
      repo,
      task: 'review',
      focus: ['review'],
      family: { id: 'f1', name: 'Game apps' },
      repoDocs: [{ file: 'REVIEW.md', text: 'Flag raw fooUtil calls.' }],
      sections: [
        row({ scope: 'all', rules: 'ALL.' }),
        row({ scope: 'group:web', rules: 'WEB.' }),
        row({ scope: 'group:games', rules: 'GAMES.' }),
        row({ scope: 'family:f1', rules: 'FAMILY.' }),
        row({
          scope: 'repo:work:games/app',
          rules: 'REPO.',
          learnings: [
            {
              id: 'l1',
              rule: 'Keep shape sizes in ShapeSize.',
              sources: [],
              acceptedBy: 'ana',
              acceptedAt: '2026-11-01T10:00:00.000Z',
            },
          ],
        }),
      ],
    })
    expect(chainLayers(resolved).map((layer) => [layer.n, layer.kind, layer.source])).toEqual([
      [1, 'repo-file', 'REVIEW.md'],
      [2, 'repo', 'This repository'],
      [3, 'family', 'Family Game apps'],
      [4, 'group', 'Team games'],
      [5, 'group', 'Team web'],
      [6, 'all', 'All repositories'],
      [7, 'learnings', 'Learned rules'],
    ])
  })

  test('maps sections to the task their prompt stands for', () => {
    expect(chainTaskOf('review')).toBe('review')
    expect(chainTaskOf('releases')).toBe('release-notes')
    expect(chainTaskOf('commits')).toBe('release-notes')
    expect(chainTaskOf('testing')).toBe('agent')
  })
})

describe('buildGuideChain', () => {
  test('resolves each section on its own with the store resolver and keeps the 12k budget', async () => {
    const store = memoryStore()
    await store.guides.put({ ...row({ scope: 'group:games', rules: 'GAMES review.' }) })
    await store.guides.put({ ...row({ scope: 'all', section: 'general', rules: 'ALL general.' }) })
    const resolve = createGuideResolver({ store })
    const chain = await buildGuideChain(resolve, {
      repo,
      repoDocs: [{ file: 'AGENTS.md', text: 'Run bun test.' }],
    })
    expect(chain.sections.map((section) => section.section)).toEqual([
      'general',
      'review',
      'testing',
      'testids',
      'assets',
      'commits',
      'releases',
    ])
    const review = chain.sections.find((section) => section.section === 'review')
    expect(review?.layers.map((layer) => layer.kind)).toEqual(['repo-file', 'group'])
    expect(review?.layers.map((layer) => layer.text).join('')).not.toContain('ALL general')
    expect(chain.budget.total).toBe(12_000)

    const one = await buildGuideChain(resolve, { repo, sections: ['review'] })
    expect(one.sections).toHaveLength(1)
    const direct = await resolve({ repo, task: 'review', focus: ['review'] })
    expect(one.sections[0]?.layers).toEqual(chainLayers(direct))
    const prompt = await resolve({ repo, task: 'review', section: 'review' })
    expect(one.budget).toEqual(prompt.budget)
    expect(one.budget.used).toBeGreaterThan(direct.budget.used)
  })
})
