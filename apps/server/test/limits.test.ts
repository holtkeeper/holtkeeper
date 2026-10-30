import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import { gitlab } from '@holtkeeper/forge-gitlab'
import { createLimiter } from '@holtkeeper/limits'
import type { Job } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { fileForgeKey, globalLimits, jobLimitKeys, limitFileForges } from '../src/limits.ts'

const job = (analyzer: string, forge = 'work') =>
  ({ analyzer, repo: { forge, path: 'games/a' } }) as Job

describe('server limits', () => {
  test('file forges send requests through the limiter under forge:<id>', async () => {
    const limiter = createLimiter()
    const seen: string[] = []
    const forges = limitFileForges(
      {
        work: gitlab({
          url: 'https://gl.test',
          token: 't',
          fetch: async (input) => {
            seen.push(input)
            return Response.json({
              path_with_namespace: 'a/b',
              name: 'b',
              web_url: '',
              http_url_to_repo: '',
            })
          },
        }),
      },
      limiter,
      [],
    )
    await forges.work?.create().getRepository('a/b')
    expect(seen).toHaveLength(1)
    expect(Object.keys(await limiter.snapshot())).toContain(fileForgeKey('work'))
  })

  test('globalLimits reads the everything-scope entry', () => {
    const value = { 'forge:work': { maxConcurrent: 2 } }
    expect(
      globalLimits([
        {
          id: 'a',
          key: 'limits.credentials',
          scope: { groups: ['x'] },
          value: {},
          secret: false,
          updatedAt: '',
        },
        {
          id: 'b',
          key: 'limits.credentials',
          scope: { all: true },
          value,
          secret: false,
          updatedAt: '',
        },
      ]),
    ).toEqual(value)
  })

  test('job keys: forge credential, then the AI provider for agent analyzers', async () => {
    const store = memoryStore()
    const config = parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gl.test', create: () => ({}) as never } },
      groups: { games: { forge: 'work', include: ['games/*'] } },
    })
    const keys = jobLimitKeys({
      config,
      store,
      forgeCredential: (id) => (id === 'cloud' ? 'cred-1' : undefined),
      needsAgent: (kind) => kind === 'review',
    })
    expect(await keys(job('depgraph'))).toEqual(['forge:work'])
    expect(await keys(job('depgraph', 'cloud'))).toEqual(['cred-1'])
    expect(await keys(job('review'))).toEqual(['forge:work'])
    await store.credentials.put({
      id: 'ai-1',
      name: 'corp-ai',
      kind: 'anthropic-compatible',
      url: 'https://ai.test',
      scope: { all: true },
      secret: 's',
      createdAt: '',
      updatedAt: '',
    })
    await store.settings.put({
      id: 's',
      key: 'llm.provider',
      scope: { all: true },
      value: 'corp-ai',
      secret: false,
      updatedAt: '',
    })
    expect(await keys(job('review'))).toEqual(['forge:work', 'ai-1'])
  })
})
