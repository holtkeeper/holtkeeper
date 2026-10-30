import { describe, expect, test } from 'bun:test'

import { ConfigError, parseConfig } from '@holtkeeper/core'
import type { ForgeDefinition, GitForge } from '@holtkeeper/forge'
import type { AnyConfigDocument, ConfigDocumentInput } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { effectiveConfig, type ForgeFactory } from './effective.ts'
import { exportConfig } from './export.ts'
import { generateWebhookSecret } from './secret.ts'
import { createConfigSource, liveConfig } from './source.ts'

const fileForge: ForgeDefinition = {
  kind: 'gitlab',
  url: 'https://file.test',
  create: () => ({ kind: 'gitlab' }) as GitForge,
}

const file = parseConfig({
  forges: { work: fileForge },
  groups: { games: { forge: 'work', include: ['games/*'] } },
  repos: { 'games/app-*': { traits: { webgl: true } } },
  jobs: {
    schedules: [{ name: 'nightly', cron: '0 3 * * *', analyzers: ['depgraph'] }],
    onTag: { analyzers: ['changelog'] },
    webhookSecret: { env: 'HOOK' },
  },
})

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
    data: { kind: 'gitlab', url: 'https://gitlab.com', credentialId: 'c1' },
  }),
  doc({ type: 'group', id: 'games', data: { forge: 'cloud', include: ['studio/*'], exclude: [] } }),
  doc({
    type: 'group',
    id: 'tools',
    data: { forge: 'work', include: ['tools/*'], exclude: ['tools/old'] },
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
      groups: ['tools'],
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
  test('panel documents override and extend file entries, with provenance', () => {
    const effective = effectiveConfig(file, documents, {
      forgeFactories: { gitlab: factory },
      tokens: { c1: 'secret-token' },
      webhookSecrets: { cloud: 'hook-secret' },
    })
    const { config, provenance } = effective
    expect(Object.keys(config.forges).toSorted()).toEqual(['cloud', 'work'])
    expect(config.forges.work).toBe(fileForge)
    expect(config.forges.cloud?.url).toBe('https://gitlab.com')
    expect(config.groups.games).toEqual({ forge: 'cloud', include: ['studio/*'], exclude: [] })
    expect(config.repos['tools/*']).toEqual({ traits: { lang: 'go' } })
    expect(config.jobs?.schedules.map((s) => [s.name, s.enabled, s.title])).toEqual([
      ['nightly', false, 'Nightly'],
      ['office', true, 'Office hours'],
    ])
    expect(config.jobs?.onTag).toEqual({ analyzers: ['changelog', 'depgraph'] })
    expect(config.jobs?.onLabel).toEqual({ port: ['port'] })
    expect(config.jobs?.webhooks).toEqual({ cloud: { secret: 'hook-secret' } })
    expect(config.jobs?.webhookSecret).toEqual({ env: 'HOOK' })
    expect(provenance).toEqual({
      'forge:work': 'file',
      'forge:cloud': 'panel',
      'group:games': 'file+panel',
      'group:tools': 'panel',
      'repoTraits:games/app-*': 'file',
      'repoTraits:tools/*': 'panel',
      'schedule:nightly': 'file+panel',
      'schedule:office': 'panel',
      'trigger:tag': 'file+panel',
      'trigger:label:port': 'panel',
    })
    expect(effective.forges.cloud).toEqual({
      kind: 'gitlab',
      url: 'https://gitlab.com',
      credentialId: 'c1',
    })
  })

  test('validates with the file config rules', () => {
    const broken = [
      ...documents,
      doc({ type: 'group', id: 'apps', data: { forge: 'nowhere', include: ['a/*'], exclude: [] } }),
    ]
    expect(() => effectiveConfig(file, broken, { forgeFactories: { gitlab: factory } })).toThrow(
      ConfigError,
    )
    expect(() => effectiveConfig(file, broken, { forgeFactories: {} })).toThrow(
      'unknown forge "nowhere"',
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

  test('a file without jobs gets one only when the panel adds jobs entries', () => {
    const bare = parseConfig({ forges: { work: fileForge } })
    expect(effectiveConfig(bare, [], { forgeFactories: {} }).config.jobs).toBeUndefined()
    const withSchedule = effectiveConfig(
      bare,
      documents.filter((d) => d.id === 'r1' || d.type === 'trigger'),
      {
        forgeFactories: {},
      },
    )
    expect(withSchedule.config.jobs?.concurrency).toBe(2)
  })
})

describe('exportConfig', () => {
  test('is deterministic TypeScript with env placeholders', () => {
    const effective = effectiveConfig(file, documents, {
      forgeFactories: { gitlab: factory },
      tokens: { c1: 'secret-token' },
      webhookSecrets: { cloud: 'hook-secret' },
    })
    const source = exportConfig(effective)
    expect(source).toBe(
      exportConfig(
        effectiveConfig(file, [...documents], {
          forgeFactories: { gitlab: factory },
          tokens: { c1: 'other-token' },
          webhookSecrets: { cloud: 'other' },
        }),
      ),
    )
    expect(source).not.toContain('secret-token')
    expect(source).not.toContain('hook-secret')
    expect(source).toStartWith('// holtkeeper.config.ts exported from the Holtkeeper panel.')
    expect(source).toContain(`import { defineConfig, env } from '@holtkeeper/core'
import { gitlab } from '@holtkeeper/forge-gitlab'

export default defineConfig({
  forges: {
    cloud: gitlab({
      url: 'https://gitlab.com',
      token: env('HOLTKEEPER_CLOUD_TOKEN'),
    }),
    work: gitlab({
      url: 'https://file.test',
      token: env('HOLTKEEPER_WORK_TOKEN'),
    }),
  },
  groups: {
    games: {
      forge: 'cloud',
      include: ['studio/*'],
    },
    tools: {
      forge: 'work',
      include: ['tools/*'],
      exclude: ['tools/old'],
    },
  },`)
    expect(source).toContain(`  repos: {
    'games/app-*': {
      traits: {
        webgl: true,
      },
    },`)
    expect(source).toContain("webhookSecret: env('HOOK'),")
    expect(source).toContain("secret: env('HOLTKEEPER_CLOUD_WEBHOOK_SECRET'),")
    expect(source).toContain('enabled: false,')
    expect(source).toContain("days: ['mon', 'fri'],")
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
    source.subscribe((effective) => seen.push(Object.keys(effective.config.groups).join(',')))

    const client = live.forges.cloud?.create()
    expect(live.forges.cloud?.create()).toBe(client)
    expect(await source.refresh()).toBe(source.effective())
    expect(seen).toEqual([])
    expect(builds).toHaveLength(1)

    await put({
      type: 'group',
      id: 'tools',
      data: { forge: 'cloud', include: ['t/*'], exclude: [] },
      updatedAt: at,
    })
    await source.refresh()
    expect(seen).toEqual(['games,tools'])
    expect(live.groups.tools?.forge).toBe('cloud')
    expect('tools' in live.groups).toBeTrue()
    expect(forges).not.toBe(live.forges)
    expect(live.forges.cloud?.create()).toBe(client)
    expect(builds).toHaveLength(1)

    token = 't2'
    await source.refresh()
    expect(builds.map((b) => b.token)).toEqual(['t1', 't2'])
    expect(live.forges.cloud?.create()).not.toBe(client)

    await put({
      type: 'group',
      id: 'bad',
      data: { forge: 'nope', include: ['x'], exclude: [] },
      updatedAt: at,
    })
    await source.refresh()
    expect(source.lastError()).toContain('unknown forge "nope"')
    expect('bad' in live.groups).toBeFalse()
    await config.remove('group', 'bad')

    expect(
      source.preview({
        put: {
          type: 'group',
          id: 'x',
          data: { forge: 'nope', include: ['x'], exclude: [] },
          updatedAt: at,
        },
      }),
    ).rejects.toThrow('unknown forge')
    const preview = await source.preview({ remove: { type: 'group', id: 'tools' } })
    expect(preview.config.groups.tools).toBeUndefined()

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

  test('without a store it serves the file config', async () => {
    const source = await createConfigSource({ file, forgeFactories: {} })
    expect(source.current()).toEqual(file)
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
