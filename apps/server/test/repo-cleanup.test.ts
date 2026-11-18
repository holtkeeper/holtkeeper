import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { REPO_CLEANUP_GRACE_MS, runRepoCleanup } from '../src/repo-cleanup.ts'

const forge = { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never }
const config = parseConfig({
  forges: { work: forge },
  teams: { games: { owns: ['work:games/*'] } },
})

const alpha: RepoRef = { forge: 'work', path: 'games/alpha' }
const beta: RepoRef = { forge: 'work', path: 'games/beta' }
const team: RepoRef = { forge: 'work', path: 'games' }

async function setup() {
  const store = memoryStore()
  let clock = new Date('2026-11-18T10:00:00.000Z')
  const analyzers = [
    { kind: 'depgraph', scope: 'repo' as const, options: z.object({}) },
    { kind: 'stack', scope: 'group' as const, options: z.object({}) },
  ]
  const deps = { config, store, analyzers, now: () => clock }
  const add = (repo: RepoRef, kind: string) =>
    store.analyses.add({ repo, kind, createdAt: clock.toISOString(), data: {} })
  await add(alpha, 'depgraph')
  await add(alpha, 'audit')
  await add(beta, 'depgraph')
  await add(team, 'stack')
  let listing: { repos: RepoRef[]; failed: string[] } = { repos: [alpha], failed: [] }
  const run = () => runRepoCleanup(deps, { listFleet: async () => listing })
  return {
    store,
    run,
    tick: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    list: (next: typeof listing) => {
      listing = next
    },
  }
}

describe('runRepoCleanup', () => {
  test('deletes the records of a repository missing from the fleet for the grace period', async () => {
    const { store, run, tick } = await setup()
    expect(await run()).toEqual({ missing: ['work:games/beta'], removed: [], skipped: [] })
    tick(REPO_CLEANUP_GRACE_MS - 1)
    expect((await run())?.removed).toEqual([])
    tick(1)
    expect((await run())?.removed).toEqual([{ repo: 'work:games/beta', records: 1 }])

    expect(await store.analyses.list({ repo: beta })).toEqual([])
    expect(await store.analyses.list({ repo: alpha })).toHaveLength(2)
    expect(await store.analyses.list({ repo: team })).toHaveLength(1)
    const { events } = await store.audit.list()
    expect(events.map((event) => [event.action, event.target.repo])).toEqual([
      ['repo.forget', 'work:games/beta'],
    ])
    expect((await run())?.missing).toEqual([])
  })

  test('a failed or empty listing deletes nothing and keeps the time a repository was missed', async () => {
    const { store, run, tick, list } = await setup()
    await run()
    tick(REPO_CLEANUP_GRACE_MS)
    list({ repos: [], failed: ['work: 401 Unauthorized'] })
    expect(await run()).toEqual({ missing: [], removed: [], skipped: ['work: listing failed'] })
    list({ repos: [], failed: [] })
    expect((await run())?.skipped).toEqual(['work: listing is empty'])
    expect(await store.analyses.list({ repo: beta })).toHaveLength(1)

    list({ repos: [alpha], failed: [] })
    expect((await run())?.removed).toEqual([{ repo: 'work:games/beta', records: 1 }])
  })

  test('a repository listed again starts over', async () => {
    const { store, run, tick, list } = await setup()
    await run()
    tick(REPO_CLEANUP_GRACE_MS / 2)
    list({ repos: [alpha, beta], failed: [] })
    expect((await run())?.missing).toEqual([])
    list({ repos: [alpha], failed: [] })
    tick(REPO_CLEANUP_GRACE_MS / 2)
    expect((await run())?.removed).toEqual([])
    expect(await store.analyses.list({ repo: beta })).toHaveLength(1)
  })
})
