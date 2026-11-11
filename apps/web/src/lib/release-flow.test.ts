import { describe, expect, test } from 'bun:test'

import type { ReleaseSettings, SettingView } from '@holtkeeper/api'

import {
  addEnvironment,
  exampleTag,
  releaseFlowGraph,
  repoReleaseEntry,
  withEnvironment,
} from './release-flow.ts'

const settings = (extra: Partial<ReleaseSettings> = {}): ReleaseSettings => ({
  enabled: true,
  flow: { mode: 'merge-request', source: 'develop' },
  version: { scheme: 'semver', tagFormat: 'v{version}', prerelease: false },
  acceptance: 'none',
  changelogFile: false,
  changelog: { excludeTypes: [] },
  mergeRequest: { labels: ['release'] },
  deploy: { environments: [] },
  gates: { pipeline: true, blockingLabels: [] },
  ...extra,
})

const env = (name: string, after?: string) => ({
  name,
  confirm: true,
  ...(after ? { after } : {}),
})

const shape = (graph: ReturnType<typeof releaseFlowGraph>) => ({
  nodes: graph.nodes.map((node) => `${node.kind}:${node.id}`),
  edges: graph.edges.map(
    (edge) => `${edge.from}>${edge.to}${edge.label ? ` (${edge.label})` : ''}`,
  ),
})

describe('releaseFlowGraph', () => {
  test('merge request mode runs source → release MR → target → tag → environments', () => {
    const graph = releaseFlowGraph(
      settings({
        acceptance: 'label',
        deploy: { environments: [env('staging'), env('prod', 'staging')] },
      }),
      'main',
    )
    expect(shape(graph)).toEqual({
      nodes: [
        'branch:source',
        'request:request',
        'branch:target',
        'tag:tag',
        'environment:env:0',
        'environment:env:1',
      ],
      edges: [
        'source>request (propose)',
        'request>target (accepted by label)',
        'target>tag (version)',
        'tag>env:0',
        'env:0>env:1',
      ],
    })
    expect(graph.nodes[2]?.data).toEqual({ role: 'target', name: 'main', gated: true })
    expect(graph.edges.at(-1)?.dashed).toBe(true)
  })

  test('trunk mode starts at the target and shows acceptance before the tag', () => {
    const graph = releaseFlowGraph(
      settings({
        flow: { mode: 'trunk', source: 'develop', target: 'trunk' },
        acceptance: 'manual',
        gates: { pipeline: false, blockingLabels: [] },
      }),
    )
    expect(shape(graph)).toEqual({
      nodes: ['branch:target', 'tag:tag'],
      edges: ['target>tag (accepted by a person)'],
    })
    expect(graph.nodes[0]?.data).toEqual({ role: 'target', name: 'trunk', gated: false })
  })

  test('external mode is one node, environments hang off it; unknown afters fall back', () => {
    const graph = releaseFlowGraph(
      settings({
        flow: { mode: 'external', source: 'develop' },
        deploy: { environments: [{ ...env('prod', 'missing'), confirm: false }] },
      }),
    )
    expect(shape(graph)).toEqual({
      nodes: ['external:external', 'environment:env:0'],
      edges: ['external>env:0 (no confirm)'],
    })
  })

  test('the tag node shows an example tag', () => {
    expect(exampleTag({ scheme: 'semver', tagFormat: 'v{version}', prerelease: false })).toBe(
      'v1.4.0',
    )
    expect(exampleTag({ scheme: 'calver', tagFormat: 'release-{version}', prerelease: true })).toBe(
      'release-2026.11.0-rc.1',
    )
  })
})

describe('environment edits', () => {
  const three = settings({
    deploy: { environments: [env('staging'), env('prod', 'staging'), env('dr', 'prod')] },
  })

  test('renaming carries over to the environments deployed after it', () => {
    const next = withEnvironment(three, 0, env('qa'))
    expect(next.deploy.environments).toEqual([env('qa'), env('prod', 'qa'), env('dr', 'prod')])
  })

  test('removing drops the afters that named it', () => {
    const next = withEnvironment(three, 1, undefined)
    expect(next.deploy.environments).toEqual([env('staging'), env('dr')])
    expect(withEnvironment(three, 9, undefined)).toBe(three)
  })

  test('adding names the common environments first and deploys after the last', () => {
    const one = addEnvironment(settings())
    expect(one.deploy.environments).toEqual([env('staging')])
    const two = addEnvironment(one)
    expect(two.deploy.environments.at(-1)).toEqual(env('production', 'staging'))
    expect(addEnvironment(two).deploy.environments.at(-1)?.name).toBe('environment-3')
    const gap = settings({
      deploy: {
        environments: [env('staging'), env('production'), env('environment-4')],
      },
    })
    expect(addEnvironment(gap).deploy.environments.at(-1)).toEqual(
      env('environment-5', 'environment-4'),
    )
  })
})

const entry = (id: string, scope: SettingView['scope'], key = 'releases'): SettingView => ({
  id,
  key,
  scope,
  value: {},
  secret: false,
  updatedAt: '2026-01-01T00:00:00Z',
})

test('finds the setting that names exactly this repository', () => {
  const repo = { forge: 'w', path: 'shop/widgets' }
  const entries = [
    entry('all', { all: true }),
    entry('group', { groups: ['shop'] }),
    entry('two', { repos: ['w:shop/widgets', 'w:shop/gadgets'] }),
    entry('other', { repos: ['w:shop/widgets'] }, 'review'),
    entry('own', { repos: ['shop/widgets'] }),
  ]
  expect(repoReleaseEntry(entries, repo)?.id).toBe('own')
  expect(repoReleaseEntry(entries.slice(0, 4), repo)).toBeUndefined()
  expect(repoReleaseEntry(undefined, repo)).toBeUndefined()
})
