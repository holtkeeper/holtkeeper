import { afterEach, describe, expect, test } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findCycles, findDuplicates } from '@holtkeeper/depgraph'
import type { DepGraph } from '@holtkeeper/depgraph'

import { findLockfile, jsLockfileSource, jsWorkspaceSource } from '../src/index.ts'

const fixtures = join(import.meta.dir, 'fixtures')
const managers = ['npm', 'bun', 'pnpm', 'yarn-classic', 'yarn-berry'] as const

const summary = (graph: DepGraph) => ({
  nodes: graph.nodes
    .map((node) => `${node.kind} ${node.id}${node.path ? ` ${node.path}` : ''}`)
    .toSorted(),
  edges: graph.edges.map((edge) => `${edge.from} -> ${edge.to} (${edge.kind})`).toSorted(),
})

const expected = {
  nodes: [
    'package debug@2.6.9',
    'package debug@4.4.3',
    'package ee-first@1.1.1',
    'package encodeurl@1.0.2',
    'package escape-html@1.0.3',
    'package finalhandler@1.2.0',
    'package ms@2.0.0',
    'package ms@2.1.3',
    'package on-finished@2.4.1',
    'package parseurl@1.3.3',
    'package statuses@2.0.1',
    'package unpipe@1.0.0',
    'workspace @fx/a packages/a',
    'workspace @fx/b packages/b',
    'workspace @fx/c packages/c',
    'workspace fx-root .',
  ],
  edges: [
    '@fx/a -> @fx/b (prod)',
    '@fx/a -> debug@4.4.3 (prod)',
    '@fx/b -> @fx/c (prod)',
    '@fx/c -> @fx/a (dev)',
    '@fx/c -> finalhandler@1.2.0 (prod)',
    'debug@2.6.9 -> ms@2.0.0 (prod)',
    'debug@4.4.3 -> ms@2.1.3 (prod)',
    'finalhandler@1.2.0 -> debug@2.6.9 (prod)',
    'finalhandler@1.2.0 -> encodeurl@1.0.2 (prod)',
    'finalhandler@1.2.0 -> escape-html@1.0.3 (prod)',
    'finalhandler@1.2.0 -> on-finished@2.4.1 (prod)',
    'finalhandler@1.2.0 -> parseurl@1.3.3 (prod)',
    'finalhandler@1.2.0 -> statuses@2.0.1 (prod)',
    'finalhandler@1.2.0 -> unpipe@1.0.0 (prod)',
    'on-finished@2.4.1 -> ee-first@1.1.1 (prod)',
  ],
}

describe.each(managers)('%s fixture', (manager) => {
  const dir = join(fixtures, manager)

  test('reads the same resolved package graph from the lockfile', async () => {
    const source = jsLockfileSource()
    expect(await source.detect(dir)).toBe(true)
    const [layer] = await source.load(dir)
    expect(layer?.id).toBe('packages')
    expect(summary(layer?.graph as DepGraph)).toEqual(expected)
  })

  test('finds debug and ms in two versions with paths from workspaces', async () => {
    const [layer] = await jsLockfileSource().load(dir)
    const duplicates = findDuplicates(layer?.graph as DepGraph)
    expect(duplicates.map((duplicate) => duplicate.name)).toEqual(['debug', 'ms'])
    expect(duplicates[0]?.versions).toEqual([
      {
        version: '2.6.9',
        id: 'debug@2.6.9',
        dependents: ['finalhandler@1.2.0'],
        path: ['@fx/c', 'finalhandler@1.2.0', 'debug@2.6.9'],
      },
      {
        version: '4.4.3',
        id: 'debug@4.4.3',
        dependents: ['@fx/a'],
        path: ['@fx/a', 'debug@4.4.3'],
      },
    ])
  })

  test('reads the workspace cycle a -> b -> c -> a', async () => {
    const [layer] = await jsWorkspaceSource().load(dir)
    expect(layer?.source).toBe(manager === 'pnpm' ? 'pnpm-workspace.yaml' : 'package.json')
    expect(findCycles(layer?.graph as DepGraph)).toEqual([
      { members: ['@fx/a', '@fx/b', '@fx/c'], path: ['@fx/a', '@fx/b', '@fx/c', '@fx/a'] },
    ])
  })
})

describe('findLockfile', () => {
  let dir: string | undefined
  afterEach(() => (dir ? rm(dir, { recursive: true, force: true }) : undefined))

  test('prefers the lockfile of packageManager when several exist', async () => {
    dir = await mkdtemp(join(tmpdir(), 'holtkeeper-depgraph-js-'))
    await cp(join(fixtures, 'npm'), dir, { recursive: true })
    await cp(join(fixtures, 'yarn-classic', 'yarn.lock'), join(dir, 'yarn.lock'))
    expect((await findLockfile(dir))?.file).toBe('package-lock.json')
    const manifest = (await Bun.file(join(dir, 'package.json')).json()) as Record<string, unknown>
    await Bun.write(
      join(dir, 'package.json'),
      JSON.stringify({ ...manifest, packageManager: 'yarn@1.22.22' }),
    )
    expect((await findLockfile(dir))?.file).toBe('yarn.lock')
  })

  test('detects nothing without a lockfile', async () => {
    dir = await mkdtemp(join(tmpdir(), 'holtkeeper-depgraph-js-'))
    await Bun.write(join(dir, 'package.json'), '{"name":"x"}')
    expect(await jsLockfileSource().detect(dir)).toBe(false)
  })
})
