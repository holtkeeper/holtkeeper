import { describe, expect, test } from 'bun:test'

import { ConfigError, parseConfigFile } from '@holtkeeper/core'
import type { GitForge } from '@holtkeeper/forge'
import type { AnyConfigDocument, ConfigDocumentInput } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { teamIdSchema } from './documents.ts'
import { effectiveConfig, type ForgeFactory } from './effective.ts'
import { generateWebhookSecret } from './secret.ts'
import { createConfigSource, liveConfig } from './source.ts'

const file = parseConfigFile(
  { jobs: { webhookSecret: { env: 'HOOK' }, concurrency: 3 } },
  { warn: () => {} },
)

const builds: { id: string; token: string }[] = []
const factory: ForgeFactory = (doc, token) => {
  builds.push({ id: doc.id, token })
  let created = 0
  return {
    kind: 'gitlab',
    url: doc.data.url,
    create: () => ({ kind: 'gitlab', created: ++created }) as unknown as GitForge,
  }
}

const at = '2026-10-30T12:00:00.000Z'
const doc = <T extends AnyConfigDocument>(input: Omit<T, 'version' | 'updatedAt'>): T =>
  ({ ...input, version: 1, updatedAt: at }) as T

const documents: AnyConfigDocument[] = [
  doc({
    type: 'forge',
    id: 'cloud',
    data: { kind: 'gitlab', url: 'https://gitlab.com', credentialId: 'c1', botUsername: 'keeper' },
  }),
  doc({
    type: 'forge',
    id: 'work',
    data: { kind: 'gitlab', url: 'https://work.test', credentialId: 'c3', include: ['misc/*'] },
  }),
  doc({
    type: 'team',
    id: 'games',
    data: { owns: ['cloud:studio/*'], exclude: [], consumes: [], members: [] },
  }),
  doc({
    type: 'team',
    id: 'tools',
    data: {
      title: 'Tooling crew',
      owns: ['work:tools/*'],
      exclude: ['tools/old'],
      consumes: ['studio/**'],
      members: [{ id: 'ada', role: 'maintainer' }],
    },
  }),
  doc({ type: 'repoTraits', id: 'r1', data: { pattern: 'tools/*', traits: { lang: 'go' } } }),
  doc({
    type: 'schedule',
    id: 'nightly',
    data: { name: 'Nightly', enabled: false, every: '1d', analyzers: ['depgraph'] },
  }),
  doc({
    type: 'schedule',
    id: 'office',
    data: {
      name: 'Office hours',
      enabled: true,
      every: '1h',
      timezone: 'Europe/Berlin',
      windows: { allow: [{ days: ['mon', 'fri'], from: '09:00', to: '18:00' }] },
      analyzers: ['quality'],
      teams: ['tools'],
    },
  }),
  doc({
    type: 'trigger',
    id: 'label:port',
    data: { on: 'label', label: 'port', analyzers: ['port'] },
  }),
  doc({ type: 'trigger', id: 'tag', data: { on: 'tag', analyzers: ['changelog', 'depgraph'] } }),
]

describe('effectiveConfig', () => {
  test('panel documents become forges, teams, traits, schedules and triggers', () => {
    const effective = effectiveConfig(file, documents, {
      forgeFactories: { gitlab: factory },
      tokens: { c1: 'secret-token', c3: 'work-token' },
      webhookSecrets: { cloud: 'hook-secret' },
    })
    const { config } = effective
    expect(Object.keys(config.forges).toSorted()).toEqual(['cloud', 'work'])
    expect(config.forges.work?.url).toBe('https://work.test')
    expect(config.forges.cloud?.url).toBe('https://gitlab.com')
    expect(config.jobs.botUsernames).toEqual({ cloud: 'keeper' })
    expect(config.jobs.concurrency).toBe(3)
    expect(config.teams.games).toEqual({
      owns: ['cloud:studio/*'],
      exclude: [],
      consumes: [],
      members: [],
    })
    expect(config.teams.tools?.title).toBe('Tooling crew')
    expect(config.fleet).toEqual({ work: { include: ['misc/*'], exclude: [] } })
    expect(config.teams.tools?.members).toEqual([{ id: 'ada', role: 'maintainer' }])
    expect(config.repos['tools/*']).toEqual({ traits: { lang: 'go' } })
    expect(config.jobs?.schedules.map((s) => [s.name, s.enabled, s.title])).toEqual([
      ['nightly', false, 'Nightly'],
      ['office', true, 'Office hours'],
    ])
    expect(config.jobs.onTag).toEqual({ analyzers: ['changelog', 'depgraph'] })
    expect(config.jobs?.onLabel).toEqual({ port: ['port'] })
    expect(config.jobs?.webhooks).toEqual({ cloud: { secret: 'hook-secret' } })
    expect(config.jobs?.webhookSecret).toEqual({ env: 'HOOK' })
    expect(effective.forges.cloud).toEqual({
      kind: 'gitlab',
      url: 'https://gitlab.com',
      credentialId: 'c1',
    })
  })

  test('a new repository trigger becomes jobs.onNewRepo', () => {
    const { config } = effectiveConfig(
      file,
      [
        ...documents.filter((d) => d.type === 'forge' || d.id === 'games'),
        doc({
          type: 'trigger',
          id: 'new-repo',
          data: { on: 'newRepo', exclude: ['quality'], teams: ['games'], repos: ['tools/*'] },
        }),
      ],
      {
        forgeFactories: { gitlab: factory },
        tokens: {},
      },
    )
    expect(config.jobs?.onNewRepo).toEqual({
      exclude: ['quality'],
      teams: ['games'],
      repos: ['tools/*'],
    })
  })

  test('rejects documents that reference each other wrongly', () => {
    const broken = [
      ...documents,
      doc({
        type: 'team',
        id: 'apps',
        data: { owns: ['nowhere:a/*'], exclude: [], consumes: [], members: [] },
      }),
    ]
    expect(() => effectiveConfig(file, broken, { forgeFactories: { gitlab: factory } })).toThrow(
      ConfigError,
    )
    expect(() => effectiveConfig(file, broken, { forgeFactories: {} })).toThrow(
      'unknown forge "nowhere"',
    )
  })

  test('team ids are flat keys and unknown teams are refused', () => {
    expect(teamIdSchema.safeParse('shapes').success).toBe(true)
    expect(teamIdSchema.safeParse('shapes.round').success).toBe(false)
    const orphan = [
      ...documents,
      doc({ type: 'trigger', id: 'push', data: { on: 'push', analyzers: ['x'], teams: ['gone'] } }),
    ]
    expect(() => effectiveConfig(file, orphan, { forgeFactories: { gitlab: factory } })).toThrow(
      'unknown team "gone"',
    )
  })

  test('forges without token or adapter fail only when used', () => {
    const { config } = effectiveConfig(
      file,
      [
        ...documents,
        doc({
          type: 'forge',
          id: 'hub',
          data: { kind: 'github', url: 'https://github.com', credentialId: 'c2' },
        }),
      ],
      { forgeFactories: { gitlab: factory } },
    )
    expect(() => config.forges.cloud?.create()).toThrow('credential c1 is not available')
    expect(() => config.forges.hub?.create()).toThrow('no github adapter')
  })

  test('a bare file still has a jobs section and no forges', () => {
    const bare = parseConfigFile({}, { warn: () => {} })
    const { config } = effectiveConfig(bare, [], { forgeFactories: {} })
    expect(config.forges).toEqual({})
    expect(config.jobs).toMatchObject({ concurrency: 2, schedules: [] })
  })
})

describe('createConfigSource', () => {
  test('rebuilds on refresh, notifies on change, reuses forge clients per version', async () => {
    const store = memoryStore()
    const config = store.config
    if (!config) throw new Error('memory store has config')
    const put = (input: ConfigDocumentInput) => config.put(input)
    await put({
      type: 'forge',
      id: 'cloud',
      data: { kind: 'gitlab', url: 'https://gitlab.com', credentialId: 'c1' },
      updatedAt: at,
    })
    let token = 't1'
    builds.length = 0
    const source = await createConfigSource({
      file,
      store: config,
      forgeFactories: { gitlab: factory },
      revealToken: async () => token,
      openSecret: async (sealed) => sealed.replace('sealed:', ''),
    })
    const live = liveConfig(source)
    const forges = live.forges
    const seen: string[] = []
    source.subscribe((effective) => seen.push(Object.keys(effective.config.teams).join(',')))

    const client = live.forges.cloud?.create()
    expect(live.forges.cloud?.create()).toBe(client)
    expect(await source.refresh()).toBe(source.effective())
    expect(seen).toEqual([])
    expect(builds).toHaveLength(1)

    await put({
      type: 'team',
      id: 'tools',
      data: { owns: ['cloud:t/*'], exclude: [], consumes: [], members: [] },
      updatedAt: at,
    })
    await source.refresh()
    expect(seen).toEqual(['tools'])
    expect(live.teams.tools?.owns).toEqual(['cloud:t/*'])
    expect('tools' in live.teams).toBeTrue()
    expect(forges).not.toBe(live.forges)
    expect(live.forges.cloud?.create()).toBe(client)
    expect(builds).toHaveLength(1)

    token = 't2'
    await source.refresh()
    expect(builds.map((b) => b.token)).toEqual(['t1', 't2'])
    expect(live.forges.cloud?.create()).not.toBe(client)

    await put({
      type: 'team',
      id: 'bad',
      data: { owns: ['nope:x'], exclude: [], consumes: [], members: [] },
      updatedAt: at,
    })
    await source.refresh()
    expect(source.lastError()).toContain('unknown forge "nope"')
    expect('bad' in live.teams).toBeFalse()
    await config.remove('team', 'bad')

    expect(
      source.preview({
        put: {
          type: 'team',
          id: 'x',
          data: { owns: ['nope:x'], exclude: [], consumes: [], members: [] },
          updatedAt: at,
        },
      }),
    ).rejects.toThrow('unknown forge')
    const preview = await source.preview({ remove: { type: 'team', id: 'tools' } })
    expect(preview.config.teams.tools).toBeUndefined()

    const current = await config.get('forge', 'cloud')
    if (!current) throw new Error('missing forge')
    await put({
      ...current,
      data: { ...current.data, webhook: { secret: 'sealed:abc', createdAt: at } },
    })
    await source.refresh()
    expect(live.jobs?.webhooks?.cloud?.secret).toBe('abc')
    source.close()
  })

  test('without a store it serves the file config alone', async () => {
    const source = await createConfigSource({ file, forgeFactories: {} })
    expect(source.current()).toMatchObject({ ...file, forges: {}, teams: {} })
    expect((await source.refresh()).config).toBe(source.current())
  })
})

test('generateWebhookSecret: 32 random bytes as base64url', () => {
  const secret = generateWebhookSecret()
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(generateWebhookSecret()).not.toBe(secret)
})

test('document schemas check cron with croner and trigger ids are fixed', async () => {
  const { scheduleDataSchema, triggerId } = await import('./documents.ts')
  const base = { name: 'x', analyzers: ['a'] }
  expect(scheduleDataSchema.safeParse({ ...base, cron: '61 * * * *' }).success).toBeFalse()
  expect(scheduleDataSchema.safeParse({ ...base, cron: '0 3 * * 1-5' }).success).toBeTrue()
  expect(
    scheduleDataSchema.safeParse({ ...base, cron: '0 3 * * *', every: '1h' }).success,
  ).toBeFalse()
  expect(
    scheduleDataSchema.safeParse({ ...base, every: '1h', timezone: 'Mars/Base' }).success,
  ).toBeFalse()
  expect(triggerId({ on: 'command', command: 'port', analyzer: 'port' })).toBe('command:port')
  expect(triggerId({ on: 'mergeRequest', analyzers: ['review'] })).toBe('merge-request')
  expect(triggerId({ on: 'newRepo' })).toBe('new-repo')
})

test('gitlabForgeFactory builds a GitLab forge with the given fetch', async () => {
  const { gitlabForgeFactory } = await import('./factories.ts')
  const urls: string[] = []
  const definition = gitlabForgeFactory({
    fetchFor: () => async (input) => {
      urls.push(input)
      return Response.json({
        path_with_namespace: 'a/b',
        name: 'b',
        web_url: 'w',
        http_url_to_repo: 'h',
      })
    },
  })(
    {
      type: 'forge',
      id: 'cloud',
      version: 1,
      updatedAt: at,
      data: { kind: 'gitlab', url: 'https://gl.test', credentialId: 'c' },
    },
    'tok',
  )
  expect(definition.kind).toBe('gitlab')
  expect((await definition.create().getRepository('a/b')).path).toBe('a/b')
  expect(urls[0]).toStartWith('https://gl.test/api/v4/projects/a%2Fb')
})
