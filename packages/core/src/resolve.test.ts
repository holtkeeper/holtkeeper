import { describe, expect, test } from 'bun:test'

import type { ForgeDefinition } from '@holtkeeper/forge'

import { parseConfig } from './config.ts'
import { resolveRepo } from './resolve.ts'

const forge: ForgeDefinition = {
  kind: 'fake',
  url: 'https://forge.test',
  create: () => {
    throw new Error('not used')
  },
}

const config = parseConfig({
  forges: { work: forge, home: forge },
  teams: {
    gizmo: { owns: ['acme/round/**', 'acme/shared/ui-kit'], consumes: ['acme/shared/**'] },
    kit: { owns: ['work:acme/shared/**'], exclude: ['acme/shared/legacy-*'] },
  },
  repos: { 'acme/round/**': { traits: { ssr: false } } },
})

const resolve = (path: string, forgeId = 'work') => resolveRepo(config, { forge: forgeId, path })

describe('resolveRepo', () => {
  test('lists every owner team in config order', () => {
    expect(resolve('acme/shared/ui-kit').teams).toEqual(['gizmo', 'kit'])
    expect(resolve('acme/round/web').teams).toEqual(['gizmo'])
    expect(resolve('tools/cli').teams).toEqual([])
  })

  test('honours exclusions and forge prefixes', () => {
    expect(resolve('acme/shared/legacy-x').teams).toEqual([])
    expect(resolve('acme/shared/icons', 'home').teams).toEqual([])
  })

  test('lists consumers that do not own the repository', () => {
    expect(resolve('acme/shared/icons').consumers).toEqual(['gizmo'])
    expect(resolve('acme/shared/ui-kit').consumers).toEqual([])
  })

  test('merges traits by path glob', () => {
    expect(resolve('acme/round/web').traits).toEqual({ ssr: false })
    expect(resolve('acme/square/web').traits).toEqual({})
  })
})
