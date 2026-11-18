import { describe, expect, test } from 'bun:test'

import { type KnowledgeAccess, knowledgeTools } from '../src/index.ts'
import { call } from './fixture.ts'

const ctx = { dir: '/repo', signal: new AbortController().signal }
const repo = { forge: 'gitlab', path: 'acme/round/web', teams: ['widgets'] }

function fakeAccess() {
  const searches: unknown[][] = []
  const proposals: unknown[][] = []
  const access: KnowledgeAccess = {
    async search(query, options) {
      searches.push([query, options])
      return [
        {
          id: 'rule:r1',
          title: 'Use zod',
          body: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'),
          score: 0.912,
        },
        { id: 'learn:l2', title: 'Pin node', body: 'short', score: 0.5 },
      ]
    },
    async propose(input, options) {
      proposals.push([input, options])
      return input.text === 'dup'
        ? { id: 'l1', status: 'rejected', duplicateOf: 'l1' }
        : { id: 'l4', status: 'pending' }
    },
  }
  return { access, searches, proposals }
}

describe('knowledge tools', () => {
  test('search passes scope and trims bodies', async () => {
    const { access, searches } = fakeAccess()
    const tools = knowledgeTools({
      access,
      repo,
      taskKind: 'review',
      actor: 'agent:review',
      budget: { maxResultLines: 20 },
    })
    const out = await call(tools, 'search_knowledge', { query: 'validation', limit: 2 }, ctx)
    expect(searches).toEqual([['validation', { repo, taskKind: 'review', limit: 2 }]])
    expect(out).toStartWith('[rule:r1] Use zod (0.91)\n  line 0')
    expect(out).toContain('more lines')
    expect(out).toContain('[learn:l2] Pin node (0.50)\n  short')
    expect(out.split('\n').length).toBeLessThanOrEqual(20)
  })

  test('propose_learning sends the rule with actor and repository', async () => {
    const { access, proposals } = fakeAccess()
    const tools = knowledgeTools({ access, repo, taskKind: 'refactor', actor: 'agent:refactor' })
    expect(
      await call(
        tools,
        'propose_learning',
        { text: 'Keep widget sizes in WidgetSize.', files: ['src/widgets/**'] },
        ctx,
      ),
    ).toBe('proposed [learn:l4] (pending)')
    expect(proposals[0]).toEqual([
      { text: 'Keep widget sizes in WidgetSize.', files: ['src/widgets/**'] },
      { actor: 'agent:refactor', repo, taskKind: 'refactor' },
    ])
    expect(await call(tools, 'propose_learning', { text: 'dup' }, ctx)).toBe(
      'not added: repeats [learn:l1] (rejected)',
    )
  })
})
