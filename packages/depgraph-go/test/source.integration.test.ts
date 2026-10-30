import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeDependencies } from '@holtkeeper/depgraph'
import type { DepgraphData } from '@holtkeeper/depgraph'

import { goSource } from '../src/index.ts'

const hasGo = Bun.which('go') !== null
let dir: string
let data: DepgraphData

beforeAll(async () => {
  if (!hasGo) return
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-depgraph-go-'))
  await cp(join(import.meta.dir, '../../../fixtures/go'), dir, { recursive: true })
  data = await analyzeDependencies({ dir, sources: [goSource()] })
})

afterAll(() => (dir ? rm(dir, { recursive: true, force: true }) : undefined))

test.skipIf(!hasGo)('reads the module graph of the Go fixture with the real go command', () => {
  expect(data.errors).toEqual([])
  const packages = data.layers.find((layer) => layer.id === 'packages')
  expect(packages?.graph.nodes).toContainEqual({
    id: 'golang.org/x/text@v0.3.0',
    name: 'golang.org/x/text',
    version: 'v0.3.0',
    ecosystem: 'Go',
    kind: 'package',
    selected: true,
  })
  expect(packages?.graph.edges).toContainEqual({
    from: 'example.com/holtkeeper/fixture',
    to: 'golang.org/x/text@v0.3.0',
    kind: 'prod',
  })
  expect(packages?.duplicates).toEqual([])
  expect(
    data.layers.find((layer) => layer.id === 'workspaces')?.graph.nodes.map((node) => node.id),
  ).toEqual(['example.com/holtkeeper/fixture'])
})
