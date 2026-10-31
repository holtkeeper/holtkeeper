import { beforeEach, describe, expect, test } from 'bun:test'

import type { ScheduleRunList, ScheduleRunStarted } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: {
    work: {
      kind: 'gitlab',
      url: 'https://gitlab.test',
      create: () => ({ getRepository: () => createRepo() }) as never,
    },
  },
  groups: { games: { forge: 'work', include: ['games/a', 'games/b'] } },
  jobs: {
    schedules: [{ name: 'nightly', cron: '0 3 * * *', analyzers: ['ci-jobs'] }],
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['analyses:read', 'analyses:run'] }],
    reader: [{ scope: { all: true }, actions: ['analyses:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asReader = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'reader' }

let store: Store
let background: Promise<unknown>[]
let createRepo: () => Promise<{ archived: boolean }>
const setup = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      activity: store.activity,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    analyzers: [{ kind: 'ci-jobs', scope: 'repo', options: z.object({}) }],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
    onBackground: (work) => {
      background.push(work)
    },
  })
}

const settled = () => Promise.all(background.splice(0))
const runs = async () =>
  (await store.activity.list()).filter((entry) => entry.action === 'schedule.run')

const send = (path: string, method: string, headers: Record<string, string>) =>
  setup().request(path, { method, headers })

beforeEach(() => {
  store = memoryStore()
  background = []
  createRepo = async () => ({ archived: false })
})

describe('schedule routes', () => {
  test('runs a schedule by hand and lists its runs', async () => {
    const run = await send('/api/schedules/nightly/run', 'POST', asAdmin)
    expect(run.status).toBe(202)
    expect((await run.json()) as ScheduleRunStarted).toEqual({
      id: 'nightly',
      startedAt: '2026-10-30T12:00:00.000Z',
    })
    await settled()
    await send('/api/schedules/nightly/run', 'POST', asAdmin)
    await settled()
    const details = (await runs()).map((entry) => entry.details)
    expect(details).toHaveLength(2)
    expect(details).toEqual(
      expect.arrayContaining([
        { queued: 2, skipped: 0 },
        { queued: 0, skipped: 2 },
      ]),
    )

    const jobs = await store.jobs.list({ schedule: 'nightly' })
    expect(jobs.map((job) => [job.repo.path, job.actor, job.trigger])).toEqual([
      ['games/b', 'header:jane', 'schedule'],
      ['games/a', 'header:jane', 'schedule'],
    ])

    const list = await send('/api/schedules/runs', 'GET', asReader)
    const body = (await list.json()) as ScheduleRunList
    expect(body.schedules).toHaveLength(1)
    expect(body.schedules[0]?.runs[0]).toMatchObject({
      at: '2026-10-30T12:00:00.000Z',
      actor: 'header:jane',
      jobs: 2,
      queued: 2,
      analyzers: ['ci-jobs'],
    })
  })

  test('answers before the forge does and logs a failed run', async () => {
    const forge = Promise.withResolvers<{ archived: boolean }>()
    createRepo = () => forge.promise
    const run = await send('/api/schedules/nightly/run', 'POST', asAdmin)
    expect(run.status).toBe(202)
    forge.reject(new Error('gitlab is down'))
    await settled()
    expect((await runs()).map((entry) => entry.details)).toEqual([
      { queued: 0, skipped: 0, error: 'gitlab is down' },
    ])
    expect(await store.jobs.list({ schedule: 'nightly' })).toEqual([])
  })

  test('running needs analyses:run, unknown schedules are 404', async () => {
    expect((await send('/api/schedules/nightly/run', 'POST', asReader)).status).toBe(403)
    expect((await send('/api/schedules/missing/run', 'POST', asAdmin)).status).toBe(404)
  })
})
