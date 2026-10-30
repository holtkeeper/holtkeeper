import { beforeEach, describe, expect, test } from 'bun:test'

import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import { parseConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { cronError, nextRun } from './cron.ts'
import { enqueueUnique } from './enqueue.ts'
import { createScheduler, planSchedule, scheduleProblems, spreadRequests } from './scheduler.ts'

const analyzer = (kind: string, scope: 'repo' | 'group' = 'repo'): AnyAnalyzer => ({
  kind,
  analysis: { kind } as AnyAnalyzer['analysis'],
  scope,
  needs: {},
  options: z.object({ depth: z.coerce.number().optional() }),
  run: async () => ({ data: {} }),
})

const analyzers = [analyzer('depgraph'), analyzer('quality'), analyzer('fleet', 'group')]

const forge = { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never }
const config = parseConfig({
  forges: { work: forge },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
  jobs: {
    schedules: [
      {
        name: 'nightly',
        cron: '0 3 * * *',
        analyzers: ['depgraph', 'fleet'],
        groups: ['games'],
        options: { depgraph: { depth: 2 } },
      },
      { name: 'weekly', cron: '0 4 * * 1', analyzers: ['quality'], repos: ['work:*/a'] },
    ],
  },
})

const reposOf: Record<string, RepoRef[]> = {
  games: [
    { forge: 'work', path: 'games/a' },
    { forge: 'work', path: 'games/b' },
  ],
  tools: [{ forge: 'work', path: 'tools/a' }],
}
const resolveRepos = async (group: string) => reposOf[group] ?? []

let store: Store
let clock: Date
beforeEach(() => {
  store = memoryStore()
  clock = new Date('2026-10-30T02:59:00.000Z')
})

const scheduler = () =>
  createScheduler({ config, store, analyzers, resolveRepos, now: () => clock, timezone: 'UTC' })

describe('cron', () => {
  test('cronError and nextRun use croner', () => {
    expect(cronError('*/5 * * * *')).toBeUndefined()
    expect(cronError('61 * * * *')).toContain('minute')
    expect(nextRun('0 3 * * *', new Date('2026-10-30T02:00:00Z'), 'UTC')?.toISOString()).toBe(
      '2026-10-30T03:00:00.000Z',
    )
  })
})

describe('scheduler', () => {
  test('validates cron, analyzers and options up front', () => {
    const problems = scheduleProblems(
      [
        {
          name: 'x',
          cron: '99 * * * *',
          analyzers: ['depgraph', 'nope'],
          options: { depgraph: { depth: 'deep' } },
        },
      ],
      analyzers,
    )
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toContain('unknown analyzer "nope"')
    expect(problems.join('\n')).toContain('options of depgraph: depth')
    expect(() => createScheduler({ config, store, analyzers: [], resolveRepos })).toThrow(
      'unknown analyzer',
    )
  })

  test('enqueues per repository and once per group when a schedule comes due', async () => {
    const s = scheduler()
    expect(await s.tick()).toEqual([])
    clock = new Date('2026-10-30T03:00:30.000Z')
    const jobs = await s.tick()
    expect(jobs.map((j) => `${j.analyzer} ${j.repo.path} ${j.group ?? '-'}`)).toEqual([
      'depgraph games/a -',
      'depgraph games/b -',
      'fleet games games',
    ])
    expect(jobs[0]).toMatchObject({ trigger: 'schedule', options: { depth: 2 }, status: 'queued' })
    expect(await s.tick()).toEqual([])
  })

  test('group intersections pick repositories in every listed group', async () => {
    const layered = parseConfig({
      forges: { work: forge },
      groups: {
        frontend: { forge: 'work', include: ['shop/web', 'admin/ui'] },
        storefront: { forge: 'work', include: ['shop/*'] },
        'admin-panel': { forge: 'work', include: ['admin/*'] },
      },
    })
    const members: Record<string, RepoRef[]> = {
      frontend: [
        { forge: 'work', path: 'shop/web' },
        { forge: 'work', path: 'admin/ui' },
      ],
      'admin-panel': [
        { forge: 'work', path: 'admin/ui' },
        { forge: 'work', path: 'admin/api' },
      ],
    }
    const requests = await planSchedule(
      { analyzers: ['depgraph', 'fleet'], groups: [['frontend', 'storefront'], 'admin-panel'] },
      {
        config: layered,
        analyzers,
        resolveRepos: async (group) => members[group] ?? [],
      },
    )
    expect(requests.map((r) => `${r.analyzer} ${r.repo.path}`)).toEqual([
      'depgraph shop/web',
      'depgraph admin/ui',
      'depgraph admin/api',
      'fleet admin-panel',
    ])
  })

  test('jobs carry their schedule, and the person who ran it by hand', async () => {
    const jobs = await scheduler().run('weekly', { actor: 'u1' })
    expect(jobs.map((j) => [j.schedule, j.actor, j.trigger])).toEqual([
      ['weekly', 'u1', 'schedule'],
      ['weekly', 'u1', 'schedule'],
    ])
    expect(await store.jobs.list({ schedule: 'weekly' })).toHaveLength(2)
    expect(await store.jobs.list({ schedule: 'nightly' })).toEqual([])
  })

  test('repos globs filter across every group when none are named', async () => {
    const jobs = await scheduler().run('weekly')
    expect(jobs.map((j) => j.repo.path)).toEqual(['games/a', 'tools/a'])
  })

  test('skips jobs already queued or running', async () => {
    const s = scheduler()
    expect(await s.run('nightly')).toHaveLength(3)
    await store.jobs.claim('w', clock.toISOString())
    expect(await s.run('nightly')).toEqual([])
    expect(await store.jobs.list()).toHaveLength(3)
    expect(s.run('missing')).rejects.toThrow('unknown schedule')
  })

  test('enqueueUnique treats different refs as different jobs', async () => {
    const request = {
      analyzer: 'depgraph',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'tag' as const,
    }
    const at = clock.toISOString()
    expect(
      (await enqueueUnique(store.jobs, [{ ...request, ref: 'v1' }], at)).enqueued,
    ).toHaveLength(1)
    expect((await enqueueUnique(store.jobs, [{ ...request, ref: 'v1' }], at)).skipped).toHaveLength(
      1,
    )
    expect(
      (await enqueueUnique(store.jobs, [{ ...request, ref: 'v2' }, request], at)).enqueued,
    ).toHaveLength(2)
  })

  test('re-reads schedules each tick, skips disabled ones and spreads repository jobs', async () => {
    const live = parseConfig({
      forges: { work: forge },
      groups: { games: { forge: 'work', include: ['games/*'] } },
      jobs: { schedules: [] },
    })
    const logs: string[] = []
    const s = createScheduler({
      config: live,
      store,
      analyzers,
      resolveRepos,
      now: () => clock,
      timezone: 'UTC',
      log: (line) => logs.push(line),
    })
    const jobs = live.jobs
    if (!jobs) throw new Error('no jobs')
    jobs.schedules =
      parseConfig({
        forges: { work: forge },
        groups: { games: { forge: 'work', include: ['games/*'] } },
        jobs: {
          schedules: [
            { name: 'off', enabled: false, every: '1h', analyzers: ['quality'] },
            {
              name: 'hourly',
              every: '1h',
              spread: true,
              analyzers: ['depgraph', 'fleet'],
              windows: { allow: [{ days: ['fri'], from: '03:00', to: '03:30' }] },
            },
            { name: 'broken', every: '1h', analyzers: ['nope'] },
          ],
        },
      }).jobs?.schedules ?? []
    clock = new Date('2026-10-30T03:00:30.000Z')
    const created = await s.tick()
    expect(created.map((j) => `${j.analyzer} ${j.repo.path} ${j.runAfter}`)).toEqual([
      'depgraph games/a 2026-10-30T03:00:00.000Z',
      'depgraph games/b 2026-10-30T03:15:00.000Z',
      'fleet games 2026-10-30T03:00:00.000Z',
    ])
    await s.tick()
    expect(logs.filter((line) => line.includes('broken skipped'))).toHaveLength(1)
  })

  test('spreadRequests keeps group jobs at the start', () => {
    const start = new Date('2026-10-30T00:00:00.000Z')
    const end = new Date('2026-10-30T01:00:00.000Z')
    const spread = spreadRequests(
      [
        { analyzer: 'a', repo: { forge: 'w', path: 'x' }, trigger: 'schedule' },
        { analyzer: 'b', repo: { forge: 'w', path: 'x' }, trigger: 'schedule' },
        { analyzer: 'a', repo: { forge: 'w', path: 'y' }, trigger: 'schedule' },
        { analyzer: 'a', repo: { forge: 'w', path: 'z' }, trigger: 'schedule' },
        { analyzer: 'g', repo: { forge: 'w', path: 'g' }, group: 'g', trigger: 'schedule' },
      ],
      start,
      end,
    )
    expect(spread.map((r) => r.runAfter?.slice(11, 16))).toEqual([
      '00:00',
      '00:00',
      '00:20',
      '00:40',
      '00:00',
    ])
  })
})
