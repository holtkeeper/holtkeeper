import { describe, expect, test } from 'bun:test'

import type { AgentTool, Toolset } from '@holtkeeper/agent'

import { type LibraryDocsAccess, libraryTools } from './libraries.ts'

const ctx = { dir: '/repo', signal: new AbortController().signal }

function fakeAccess(reply = 'ok') {
  const calls: unknown[][] = []
  const access: LibraryDocsAccess = {
    async versions(...args) {
      calls.push(['versions', ...args])
      return reply
    },
    async search(...args) {
      calls.push(['search', ...args])
      return reply
    },
    async read(...args) {
      calls.push(['read', ...args])
      return reply
    },
    async changes(...args) {
      calls.push(['changes', ...args])
      return reply
    },
    async issues(...args) {
      calls.push(['issues', ...args])
      return reply
    },
    async source(...args) {
      calls.push(['source', ...args])
      return reply
    },
  }
  return { access, calls }
}

function tool(toolset: Toolset, name: string): AgentTool {
  const found = toolset.tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

async function call(toolset: Toolset, name: string, input: unknown): Promise<string> {
  const target = tool(toolset, name)
  return target.run(target.input.parse(input), ctx)
}

describe('libraryTools', () => {
  test('names the toolset and its tools', () => {
    const { access } = fakeAccess()
    const toolset = libraryTools({ access })
    expect(toolset.name).toBe('libraries')
    expect(toolset.tools.map((t) => t.name)).toEqual([
      'libraries.versions',
      'libraries.search',
      'libraries.read',
      'libraries.changes',
      'libraries.issues',
      'libraries.source',
    ])
  })

  test('passes inputs and the task repository as the caller', async () => {
    const { access, calls } = fakeAccess()
    const toolset = libraryTools({ access, repo: 'gitlab:g/app' })
    const caller = { repo: 'gitlab:g/app' }

    await call(toolset, 'libraries.versions', { package: 'zod' })
    await call(toolset, 'libraries.search', { query: 'refine', package: 'zod', limit: 3 })
    await call(toolset, 'libraries.read', {
      package: 'zod',
      version: '4.1.0',
      path: 'README.md',
      heading: 'Install',
    })
    await call(toolset, 'libraries.changes', { package: 'zod', from: '3.0.0', to: '4.0.0' })
    await call(toolset, 'libraries.issues', {
      package: 'github.com/spf13/cobra',
      ecosystem: 'Go',
      query: '"unknown flag"',
    })
    await call(toolset, 'libraries.source', {
      package: 'zod',
      path: 'src/index.ts',
      start: 1,
      end: 9,
    })

    expect(calls).toEqual([
      ['versions', { package: 'zod' }, caller],
      ['search', { query: 'refine', package: 'zod', limit: 3 }, caller],
      ['read', { package: 'zod', version: '4.1.0', path: 'README.md', heading: 'Install' }, caller],
      ['changes', { package: 'zod', from: '3.0.0', to: '4.0.0' }],
      [
        'issues',
        { package: 'github.com/spf13/cobra', ecosystem: 'Go', query: '"unknown flag"' },
        caller,
      ],
      ['source', { package: 'zod', path: 'src/index.ts', start: 1, end: 9 }, caller],
    ])
  })

  test('passes an empty caller without a repository', async () => {
    const { access, calls } = fakeAccess()
    await call(libraryTools({ access }), 'libraries.versions', { package: 'zod' })
    expect(calls).toEqual([['versions', { package: 'zod' }, {}]])
  })

  test('cuts results to the budget', async () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const { access } = fakeAccess(long)
    const toolset = libraryTools({ access, budget: { maxResultLines: 10, maxLineLength: 20 } })
    const out = (await call(toolset, 'libraries.read', { package: 'zod' })).split('\n')
    expect(out).toHaveLength(10)
    expect(out[0]).toBe(`line 0 ${'x'.repeat(13)}…`)
    expect(out.at(-1)).toStartWith('… 41 more lines')
  })

  test('keeps short results intact', async () => {
    const { access } = fakeAccess('# zod\n\nno matches\n')
    const out = await call(libraryTools({ access }), 'libraries.search', { query: 'x' })
    expect(out).toBe('# zod\n\nno matches')
  })

  test('validates inputs', () => {
    const { access } = fakeAccess()
    const toolset = libraryTools({ access })
    const parse = (name: string, input: unknown) =>
      tool(toolset, name).input.safeParse(input).success
    expect(parse('libraries.versions', {})).toBe(false)
    expect(parse('libraries.versions', { package: '' })).toBe(false)
    expect(parse('libraries.versions', { package: 'zod', ecosystem: 'pypi' })).toBe(false)
    expect(parse('libraries.search', { package: 'zod' })).toBe(false)
    expect(parse('libraries.search', { query: 'x', limit: 50 })).toBe(false)
    expect(parse('libraries.changes', { package: 'zod', from: '1.0.0' })).toBe(false)
    expect(parse('libraries.issues', { package: 'zod' })).toBe(false)
    expect(parse('libraries.source', { package: 'zod', start: 0 })).toBe(false)
    expect(parse('libraries.source', { package: 'zod', start: 1.5 })).toBe(false)
    expect(parse('libraries.read', { package: 'zod', ecosystem: 'Go' })).toBe(true)
  })
})
