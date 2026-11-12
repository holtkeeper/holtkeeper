import { beforeEach, describe, expect, test } from 'bun:test'

import { builtinAnalyzers } from '@holtkeeper/analyzers'
import type { ResolvedSettings, SettingList } from '@holtkeeper/api'
import { assetsPolicySetting } from '@holtkeeper/assets'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { commitConventionsSetting } from '@holtkeeper/commit-conventions'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { limitsCredentialsSetting } from '@holtkeeper/limits'
import { mergeRequestPoliciesSetting } from '@holtkeeper/mr-policies'
import { releaseNotifyDefinition, releaseSettingsDefinition } from '@holtkeeper/release'
import { type SettingDefinition, builtinSettings, defineSetting } from '@holtkeeper/settings'
import type { SettingEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { trackersSetting } from '@holtkeeper/tracker'
import { pollingSetting } from '@holtkeeper/updates'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import { freshnessSetting, freshnessSweepSetting } from '../src/freshness.ts'
import { analyzerSettings, executionSettings } from '../src/jobs.ts'
import { librariesSetting } from '../src/libraries.ts'

const registered: SettingDefinition[] = [
  ...builtinSettings,
  mergeRequestPoliciesSetting,
  limitsCredentialsSetting,
  pollingSetting,
  trackersSetting,
  releaseSettingsDefinition,
  releaseNotifyDefinition,
  commitConventionsSetting,
  assetsPolicySetting,
  librariesSetting,
  freshnessSetting,
  freshnessSweepSetting,
  ...analyzerSettings(builtinAnalyzers),
  ...executionSettings(),
]

const widgetSetting = defineSetting({
  key: 'acme.widget',
  label: 'Widget',
  description: 'Options of the widget',
  section: 'Test',
  schema: z.object({ size: z.number(), color: z.string().optional() }),
  default: { size: 3 },
})

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
})

let store: Store
beforeEach(() => {
  store = memoryStore()
})

const setup = (auth: AuthProvider = noAuth()) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...registered, widgetSetting],
    analyses: [],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const put = (id: string, key: string, scope: SettingEntry['scope'], value: unknown) =>
  store.settings.put({
    id,
    key,
    scope,
    value,
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })

const resolve = async (app: ReturnType<typeof setup>, repo = 'work:shapes/circle', headers = {}) =>
  app.request(`/api/settings/resolve?repo=${repo}`, { headers })

describe('setting defaults', () => {
  test.each(registered.map((definition) => [definition.key, definition] as const))(
    '%s has a default its schema accepts',
    (_, definition) => {
      expect('default' in definition).toBe(true)
      if (definition.default !== null)
        expect(definition.schema.safeParse(definition.default).success).toBe(true)
    },
  )

  test('analyzer defaults come from the options schema', () => {
    const audit = registered.find((definition) => definition.key === 'analyzers.audit')
    expect(audit?.default).toEqual({ fix: false, allowlist: [], traits: {} })
  })

  test('definitions list their default', async () => {
    const list = (await (await setup().request('/api/settings')).json()) as SettingList
    expect(list.definitions.find((d) => d.key === 'acme.widget')?.default).toEqual({ size: 3 })
    expect(list.definitions.find((d) => d.key === 'llm.provider')?.default).toBeNull()
    expect(list.definitions.every((d) => 'default' in d)).toBe(true)
  })
})

describe('GET /api/settings/resolve', () => {
  test('gives one row per defined key with its winner, source and what it replaces', async () => {
    await put('all', 'acme.widget', { all: true }, { size: 1, color: 'red' })
    await put('group', 'acme.widget', { groups: ['shapes'] }, { size: 2 })
    await put('repo', 'acme.widget', { repos: ['shapes/circle'] }, { size: 5 })
    await put('orphan', 'acme.unknown', { all: true }, 1)
    await put('retired', 'llm.model', { all: true }, 'old')
    const body = (await (await resolve(setup())).json()) as ResolvedSettings

    expect(body.repo).toEqual({ forge: 'work', path: 'shapes/circle' })
    const keys = body.rows.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const hidden of ['acme.unknown', 'llm.model', 'llm.models', 'releases.notify'])
      expect(keys).not.toContain(hidden)
    expect(keys.filter((key) => key.startsWith('analyzers.audit'))).toEqual(['analyzers.audit'])

    const widget = body.rows.find((row) => row.key === 'acme.widget')
    expect(widget).toMatchObject({
      label: 'Widget',
      section: 'Test',
      value: { size: 5 },
      source: { layer: 'repo', entry: { id: 'repo' } },
      replaces: { layer: 'group', groups: ['shapes'], value: { size: 2 }, entry: { id: 'group' } },
      entry: { id: 'repo' },
      overrides: 2,
    })

    const fix = body.rows.find((row) => row.key === 'audit.fix')
    expect(fix).toEqual({
      key: 'audit.fix',
      label: expect.any(String),
      section: expect.any(String),
      value: false,
      source: { layer: 'default' },
      overrides: 0,
    })
  })

  test('every row names a winner and a source', async () => {
    await put('all', 'acme.widget', { all: true }, { size: 1 })
    const body = (await (await resolve(setup())).json()) as ResolvedSettings
    for (const row of body.rows) {
      expect(['default', 'org', 'group', 'repo']).toContain(row.source.layer)
      expect('value' in row).toBe(true)
      expect(row.source.layer === 'default').toBe(row.entry === undefined)
    }
    expect(body.rows.find((row) => row.key === 'acme.widget')).toMatchObject({
      source: { layer: 'org' },
      replaces: { layer: 'default', value: { size: 3 } },
    })
  })

  test('keeps analyzer options whole instead of merging them per field', async () => {
    await put('all', 'analyzers.audit', { all: true }, { fix: true, allowlist: [] })
    await put('repo', 'analyzers.audit', { repos: ['shapes/circle'] }, { fix: false })
    const body = (await (await resolve(setup())).json()) as ResolvedSettings
    const audit = body.rows.find((row) => row.key === 'analyzers.audit')
    expect(audit?.value).toEqual({ fix: false })
    expect(audit?.replaces).toMatchObject({ layer: 'org', value: { fix: true, allowlist: [] } })
    expect(audit?.overrides).toBe(1)
  })

  test('global settings count only entries for everything', async () => {
    await put('narrow', 'llm.provider', { groups: ['shapes'] }, 'Narrow')
    const body = (await (await resolve(setup())).json()) as ResolvedSettings
    expect(body.rows.find((row) => row.key === 'llm.provider')).toMatchObject({
      value: null,
      source: { layer: 'default' },
      overrides: 0,
    })
  })

  test('a group focus applies entries for everything and the group, never path patterns', async () => {
    await put('all', 'acme.widget', { all: true }, { size: 1 })
    await put(
      'group',
      'acme.widget',
      { groups: ['shapes', 'tools'], repos: ['shapes/*'] },
      {
        size: 2,
      },
    )
    await put('repo', 'acme.widget', { repos: ['shapes/circle'] }, { size: 5 })
    await put('both', 'audit.fix', { groups: [['shapes', 'tools']] }, true)
    const response = await setup().request('/api/settings/resolve?group=shapes')
    expect(response.status).toBe(200)
    const body = (await response.json()) as ResolvedSettings
    expect(body.group).toBe('shapes')
    expect(body.repo).toBeUndefined()
    expect(body.groups).toEqual(['shapes'])
    expect(body.rows.find((row) => row.key === 'acme.widget')).toMatchObject({
      value: { size: 2 },
      source: {
        layer: 'group',
        groups: ['shapes'],
        entry: { id: 'group', scope: { repos: ['shapes/*'] } },
      },
      replaces: { layer: 'org', value: { size: 1 } },
    })
    expect(body.rows.find((row) => row.key === 'audit.fix')?.source.layer).toBe('default')
    expect((await setup().request('/api/settings/resolve?group=nope')).status).toBe(404)
    expect((await setup().request('/api/settings/resolve')).status).toBe(400)
  })

  test('needs settings:read on the repository or the group', async () => {
    const app = setup(
      headerAuth({
        roles: {
          shapes: [{ scope: { groups: ['shapes'] }, actions: ['settings:read'] }],
          circle: [{ scope: { repos: ['work:shapes/circle'] }, actions: ['settings:read'] }],
        },
      }),
    )
    const member = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'shapes' }
    expect((await resolve(app, 'work:shapes/circle', member)).status).toBe(200)
    expect((await resolve(app, 'work:tools/hammer', member)).status).toBe(403)
    const group = (name: string, headers: Record<string, string>) =>
      app.request(`/api/settings/resolve?group=${name}`, { headers })
    expect((await group('shapes', member)).status).toBe(200)
    expect((await group('tools', member)).status).toBe(403)

    const narrow = { 'x-forwarded-user': 'joe', 'x-forwarded-groups': 'circle' }
    expect((await resolve(app, 'work:shapes/circle', narrow)).status).toBe(200)
    expect((await resolve(app, 'work:shapes/square', narrow)).status).toBe(403)
    expect((await group('shapes', narrow)).status).toBe(403)
  })
})
