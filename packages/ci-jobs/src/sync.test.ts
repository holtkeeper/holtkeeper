import { describe, expect, test } from 'bun:test'

import { memoryCiJobs } from '@holtkeeper/store/memory'

import { at, attempt, fakeForge, repo, toJobRuns } from '../test/history.ts'
import { syncCiJobs } from './sync.ts'

describe('syncCiJobs', () => {
  test('reads everything first, then only from a day before the newest stored job', async () => {
    const jobs = [
      attempt('build', at(1), 10, { pipelineId: 1 }),
      attempt('build', at(5), 10, { pipelineId: 2 }),
    ]
    const forge = fakeForge(() => toJobRuns(jobs))
    const store = memoryCiJobs()

    const first = await syncCiJobs({ forge, store, repo, since: at(0), limit: 100 })
    expect(first).toMatchObject({
      mode: 'full',
      after: at(0),
      fetched: 2,
      stored: 2,
      syncedFrom: at(0),
    })

    jobs.push(attempt('build', at(6), 10, { pipelineId: 3 }))
    const second = await syncCiJobs({
      forge,
      store,
      repo,
      since: at(0),
      syncedFrom: at(0),
      limit: 100,
    })
    expect(second).toMatchObject({ mode: 'incremental', after: at(4), fetched: 2, stored: 2 })
    expect(await store.coverage(repo)).toEqual({ oldest: at(1), newest: at(6), jobs: 3 })
  })

  test('a wider window than any earlier full sync reads everything again', async () => {
    const forge = fakeForge(() => toJobRuns([attempt('build', at(5), 10)]))
    const store = memoryCiJobs()
    await syncCiJobs({ forge, store, repo, since: at(4), limit: 100 })
    const wider = await syncCiJobs({
      forge,
      store,
      repo,
      since: at(0),
      syncedFrom: at(4),
      limit: 100,
    })
    expect(wider).toMatchObject({ mode: 'full', after: at(0), syncedFrom: at(0) })
  })

  test('stores finished attempts only and notes a truncated read', async () => {
    const jobs = [
      attempt('build', at(1), 10),
      { ...attempt('build', at(2), 10), status: 'running' as never },
      attempt('test', at(3), 10),
    ]
    const store = memoryCiJobs()
    const result = await syncCiJobs({
      forge: fakeForge(() => toJobRuns(jobs)),
      store,
      repo,
      since: at(0),
      limit: 2,
    })
    expect(result).toMatchObject({ fetched: 2, stored: 1 })
    expect(result.notes[0]).toContain('stopped after 2 job attempts')
  })

  test('falls back to pipelines and their jobs, keeping the pipeline ref and commit', async () => {
    const forge = fakeForge(() => toJobRuns([attempt('build', at(1), 10, { pipelineId: 7 })]), {
      perPipeline: true,
    })
    const store = memoryCiJobs()
    await syncCiJobs({ forge, store, repo, since: at(0), limit: 100 })
    const [stored] = await store.list(repo)
    expect(stored).toMatchObject({ pipelineId: 7, ref: 'main', sha: 'p7' })
    expect(forge.calls).toEqual([`pipelines after ${at(0)}`])
  })
})
