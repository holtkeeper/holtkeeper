import { beforeEach, describe, expect, test } from 'bun:test'

import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import {
  type DocumentSink,
  DocumentVersionConflictError,
  type PublishResult,
  type TrackerData,
  trackerAnalysis,
} from '@holtkeeper/tracker'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import type { TrackerRouteDeps } from '../src/routes/trackers.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: { games: { forge: 'work', include: ['games/*'] } },
})

const data: TrackerData = {
  tracker: { id: 'flags', name: 'Feature flags', label: 'Feature flag' },
  generatedAt: '2026-10-30T12:00:00.000Z',
  entities: [],
  findings: [],
  sourcesRead: [],
  errors: [],
  publications: [
    {
      output: 'wiki',
      kind: 'document-section',
      provider: 'confluence',
      ref: '1',
      markerId: 'holtkeeper:flags',
      format: 'storage',
      content: '<p>x</p>',
      expectedVersion: 3,
    },
    {
      output: 'stale',
      kind: 'document-section',
      provider: 'confluence',
      ref: '2',
      markerId: 'm',
      format: 'storage',
      content: '<p>y</p>',
      expectedVersion: 1,
    },
    { output: 'chat', kind: 'notify', format: 'text', content: 'hi' },
  ],
  changes: [],
}

let store: Store
let writes: string[]

const sink: DocumentSink = {
  provider: 'confluence',
  async replaceSection(ref, input) {
    if (ref === '2')
      throw new DocumentVersionConflictError('moved', {
        expected: input.expectedVersion,
        actual: 5,
      })
    writes.push(`${ref}#${input.markerId}@${input.expectedVersion}`)
    return { version: 4, url: `https://wiki.test/${ref}`, changed: true }
  },
}

const setup = (auth: AuthProvider = noAuth(), sinks = true) => {
  const vault = aesVault('v'.repeat(32))
  const deps: TrackerRouteDeps = {
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
    analyses: [trackerAnalysis],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
    ...(sinks ? { documentSinks: () => ({ confluence: sink }) } : {}),
  }
  return createApp(deps)
}

const publish = (
  app: ReturnType<typeof setup>,
  id: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(`/api/trackers/${id}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

beforeEach(() => {
  store = memoryStore()
  writes = []
})

describe('POST /api/trackers/:analysisId/publish', () => {
  test('publishes planned sections, reports conflicts and records activity', async () => {
    const record = await store.analyses.add({
      repo: { forge: 'work', path: 'games' },
      kind: 'tracker',
      createdAt: '2026-10-30T12:00:00.000Z',
      data,
    })
    const response = await publish(setup(), record.id)
    expect(response.status).toBe(200)
    const result = (await response.json()) as PublishResult
    expect(result.outcomes.map((outcome) => [outcome.output, outcome.status])).toEqual([
      ['wiki', 'published'],
      ['stale', 'conflict'],
    ])
    expect(writes).toEqual(['1#holtkeeper:flags@3'])
    const [event] = await store.activity.list()
    expect(event).toMatchObject({
      action: 'tracker.published',
      subject: 'work:games',
      details: { analysis: record.id, tracker: 'flags' },
    })

    const only = (await (
      await publish(setup(), record.id, { outputs: ['stale'] })
    ).json()) as PublishResult
    expect(only.outcomes.map((outcome) => outcome.output)).toEqual(['stale'])
  })

  test('404 for other kinds, 403 without analyses:run on the group, 503 without sinks', async () => {
    const other = await store.analyses.add({
      repo: { forge: 'work', path: 'games' },
      kind: 'size',
      createdAt: '2026-10-30T12:00:00.000Z',
      data: {},
    })
    expect((await publish(setup(), other.id)).status).toBe(404)
    expect((await publish(setup(), 'missing')).status).toBe(404)
    const record = await store.analyses.add({
      repo: { forge: 'work', path: 'games' },
      kind: 'tracker',
      createdAt: '2026-10-30T12:00:00.000Z',
      data,
    })
    const reader = headerAuth({
      roles: { games: [{ scope: { groups: ['games'] }, actions: ['analyses:read'] }] },
    })
    expect(
      (
        await publish(setup(reader), record.id, undefined, {
          'x-forwarded-user': 'jane',
          'x-forwarded-groups': 'games',
        })
      ).status,
    ).toBe(403)
    expect((await publish(setup(noAuth(), false), record.id)).status).toBe(503)
    expect(writes).toEqual([])
  })
})
