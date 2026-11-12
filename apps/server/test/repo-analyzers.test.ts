import { expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import { planSchedule } from '@holtkeeper/jobs'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { automaticJobBlocker, automaticSkip, repoAnalyzersDefinition } from '../src/jobs.ts'
import { analyzerOffFor } from '../src/repo-analyzers.ts'

const config = parseConfig({
  forges: { acme: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: { shapes: { forge: 'acme', include: ['shapes/*'] } },
})

const widget = { forge: 'acme', path: 'shapes/widget' }
const core = { forge: 'acme', path: 'shapes/widget-core' }
const analyzer = { options: z.object({}) }

test('analyzers turned off are blocked for automatic jobs; a narrower entry turns them back on', async () => {
  const store = memoryStore()
  const blocker = (kind: string, repo = widget, group?: string) =>
    automaticJobBlocker(config, store, analyzer, {
      analyzer: kind,
      repo,
      ...(group !== undefined && { group }),
    })
  expect(await blocker('audit')).toBeUndefined()

  const put = (id: string, scope: Record<string, unknown>, value: unknown) =>
    store.settings.put({
      id,
      key: 'repo.analyzers',
      scope,
      value,
      secret: false,
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
  await put('group', { groups: ['shapes'] }, { off: ['audit'], reason: 'Values only' })
  await put('core', { repos: ['acme:shapes/widget-core'] }, { off: [] })
  expect(await blocker('audit')).toEqual({ blocker: 'off', reason: 'Values only' })
  expect(await blocker('bundle')).toBeUndefined()
  expect(await blocker('audit', core)).toBeUndefined()
  expect(await blocker('audit', widget, 'shapes')).toBeUndefined()
  expect(await analyzerOffFor(store, config, widget, 'audit')).toEqual({ reason: 'Values only' })
  expect(await analyzerOffFor(store, config, core, 'audit')).toBeUndefined()
})

test('the definition offers repository analyzers that run automatically', () => {
  const definition = repoAnalyzersDefinition([
    { kind: 'audit', scope: 'repo', options: z.object({}), analysis: { label: 'Vulnerabilities' } },
    { kind: 'guide', scope: 'group', options: z.object({}), analysis: { label: 'Guide' } },
    { kind: 'write-task', scope: 'repo', options: z.object({}), analysis: { label: 'Task' } },
  ] as never)
  expect(definition.schema.safeParse({ off: ['audit'] }).success).toBe(true)
  expect(definition.schema.safeParse({ off: ['guide'] }).success).toBe(false)
  expect(definition.schema.safeParse({ off: ['write-task'] }).success).toBe(false)
})

test('a schedule over two repositories leaves out the one whose audit is off', async () => {
  const store = memoryStore()
  await store.settings.put({
    id: 'widget',
    key: 'repo.analyzers',
    scope: { repos: ['acme:shapes/widget'] },
    value: { off: ['audit'] },
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  const requests = await planSchedule(
    { name: 'nightly', analyzers: ['audit'] },
    {
      config,
      analyzers: [{ kind: 'audit', scope: 'repo' }],
      resolveRepos: async () => [widget, core],
      skip: automaticSkip(store, config),
    },
  )
  expect(requests.map((request) => request.repo.path)).toEqual(['shapes/widget-core'])
})
