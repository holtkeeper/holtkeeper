import { expect, test } from 'bun:test'

import { BUNDLED_GO_GUIDELINES_TAG } from '@holtkeeper/review'
import { memoryStore } from '@holtkeeper/store/memory'

import { goGuidelinesSource, refreshGoGuidelinesIfDue } from './go-guidelines.ts'

const data = (id: string) =>
  JSON.stringify([
    {
      id,
      since_version: '1.22',
      guideline: 'Range over integers.',
      details: 'Shorter loops.',
      examples: [{ before: ['for i := 0; i < n; i++ {}'], after: ['for i := range n {}'] }],
    },
  ])

function upstream(latest: string, extra: Record<string, string> = {}) {
  const calls: string[] = []
  let failing = false
  const fetch = async (url: string) => {
    calls.push(url)
    if (failing) throw new Error('offline')
    if (url.includes('/tags')) return Response.json([{ name: latest }, { name: 'v0.0.9' }])
    const tag = /go-modern-guidelines\/(v[^/]+)\//.exec(url)?.[1] ?? ''
    return new Response(extra[tag] ?? data(`shape_${tag.replaceAll(/\W/g, '_')}`))
  }
  return { fetch, calls, fail: () => (failing = true) }
}

const at = (iso: string) => new Date(iso)

test('refreshes once a day, keeps the last good copy and serves pins', async () => {
  const store = memoryStore()
  const kv = store.kv
  if (!kv) throw new Error('memory store has kv')
  await store.settings.put({
    id: 's1',
    key: 'analyzers.review',
    scope: { all: true },
    value: { goGuidelines: { enabled: true, tag: 'v0.0.9' } },
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  const source = goGuidelinesSource(kv)
  expect((await source()).source).toBe('bundled')

  const remote = upstream('v0.2.0')
  const lines: string[] = []
  const deps = {
    kv,
    settings: store.settings,
    fetch: remote.fetch,
    log: (l: string) => lines.push(l),
  }
  expect(await refreshGoGuidelinesIfDue({ ...deps, now: at('2026-11-13T08:00:00Z') })).toBe(true)
  expect(lines).toContain('go guidelines: updated to v0.2.0 (1 guidelines)')
  expect(await source()).toMatchObject({ tag: 'v0.2.0', source: 'github' })
  expect(await source('v0.0.9')).toMatchObject({ tag: 'v0.0.9', source: 'github' })
  expect((await source(BUNDLED_GO_GUIDELINES_TAG)).source).toBe('bundled')
  expect((await source('v7.7.7')).tag).toBe('v0.2.0')

  const calls = remote.calls.length
  expect(await refreshGoGuidelinesIfDue({ ...deps, now: at('2026-11-13T20:00:00Z') })).toBe(false)
  expect(remote.calls).toHaveLength(calls)

  remote.fail()
  expect(await refreshGoGuidelinesIfDue({ ...deps, now: at('2026-11-14T09:00:00Z') })).toBe(true)
  expect(lines.at(-1)).toContain('refresh failed (offline); keeping v0.2.0')
  expect((await source()).tag).toBe('v0.2.0')
})

test('an invalid upstream file never replaces the stored copy', async () => {
  const store = memoryStore()
  const kv = store.kv
  if (!kv) throw new Error('memory store has kv')
  const deps = { kv, settings: store.settings }
  await refreshGoGuidelinesIfDue({
    ...deps,
    fetch: upstream('v0.2.0').fetch,
    now: at('2026-11-01T00:00:00Z'),
  })
  await refreshGoGuidelinesIfDue({
    ...deps,
    fetch: upstream('v0.3.0', { 'v0.3.0': '[{"id":"broken"}]' }).fetch,
    now: at('2026-11-03T00:00:00Z'),
  })
  expect((await goGuidelinesSource(kv)()).tag).toBe('v0.2.0')
  expect((await goGuidelinesSource(undefined)()).source).toBe('bundled')
})
