import { describe, expect, test } from 'bun:test'

import { type KnowledgeAccess, knowledgeTools } from '../src/index.ts'
import { call } from './fixture.ts'

const ctx = { dir: '/repo', signal: new AbortController().signal }
const repo = { forge: 'gitlab', path: 'g/app', groups: ['g'] }

function fakeAccess() {
  const searches: unknown[][] = []
  const proposals: unknown[][] = []
  const access: KnowledgeAccess = {
    async search(query, options) {
      searches.push([query, options])
      return [
        {
          id: 'k1',
          title: 'Use zod',
          kind: 'convention',
          body: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'),
          score: 0.912,
        },
        { id: 'k2', title: 'Pin node', kind: 'pitfall', body: 'short', score: 0.5 },
      ]
    },
    async propose(input, options) {
      proposals.push([input, options])
      return input.title === 'dup'
        ? { id: 'k3', status: 'rejected', duplicateOf: 'k1' }
        : { id: 'k4', status: 'pending' }
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
    const out = await call(tools, 'knowledge.search', { query: 'validation', limit: 2 }, ctx)
    expect(searches).toEqual([['validation', { repo, taskKind: 'review', limit: 2 }]])
    expect(out).toStartWith('[k1] convention: Use zod (0.91)\n  line 0')
    expect(out).toContain('more lines')
    expect(out).toContain('[k2] pitfall: Pin node (0.50)\n  short')
    expect(out.split('\n').length).toBeLessThanOrEqual(20)
  })

  test('propose sends the entry with actor and task packages', async () => {
    const { access, proposals } = fakeAccess()
    const packages = [{ ecosystem: 'npm', name: 'zod', from: '3.0.0', to: '4.0.0' }]
    const tools = knowledgeTools({
      access,
      repo,
      taskKind: 'refactor',
      actor: 'agent:refactor',
      packages,
    })
    expect(
      await call(
        tools,
        'knowledge.propose',
        {
          title: 'New',
          body: 'b',
          kind: 'migration',
          packages: [{ ecosystem: 'npm', name: 'zod' }],
        },
        ctx,
      ),
    ).toBe('proposed k4 (pending)')
    expect(proposals[0]).toEqual([
      { title: 'New', body: 'b', kind: 'migration', packages: [{ ecosystem: 'npm', name: 'zod' }] },
      { actor: 'agent:refactor', repo, taskKind: 'refactor', packages },
    ])
    expect(await call(tools, 'knowledge.propose', { title: 'dup', body: 'b' }, ctx)).toBe(
      'not added: duplicate of k1 (rejected)',
    )
  })
})
