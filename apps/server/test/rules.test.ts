import { beforeEach, describe, expect, test } from 'bun:test'

import type { EffectiveRules, RuleDetail, RuleList, RuleView } from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GitForge } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

let store: Store

const files: Record<string, string> = {
  'AGENTS.md': '# Agents\nRun the linter before committing.',
  'src/sprockets/AGENTS.md': 'Sprocket sizes come from SprocketSize.',
  'README.md': 'not a rules file',
}

const forge = {
  kind: 'gitlab',
  headCommit: async () => 'abc123',
  listFiles: async () => Object.keys(files).map((path) => ({ path, type: 'file' as const })),
  readFile: async (_repo: string, path: string) => files[path],
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://forge.test', create: () => forge } },
  teams: {
    gears: { owns: ['work:gears/*'] },
    belts: { owns: ['work:belts/*'] },
  },
})

const vault = aesVault('v'.repeat(32))

let clock = 0
const setup = (auth: AuthProvider = noAuth()) =>
  createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(Date.UTC(2026, 10, 4, 12, clock++)),
  })

const teams = headerAuth({
  roles: {
    reader: [{ scope: { teams: ['gears'] }, actions: ['knowledge:read'] }],
    member: [{ scope: { teams: ['gears'] }, actions: ['knowledge:read', 'knowledge:write'] }],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const send = (
  app: ReturnType<typeof setup>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const ruleBody = {
  title: 'Name gears by tooth count',
  body: 'Gear names end with their tooth count, e.g. `Gear24`.',
  scope: { teams: ['gears'] },
}

beforeEach(() => {
  store = memoryStore()
})

describe('rule routes', () => {
  test('a writer creates, edits with a version check and deletes a rule', async () => {
    const app = setup(teams)
    const created = await send(app, 'POST', '/api/rules', ruleBody, as('member'))
    expect(created.status).toBe(201)
    const rule = (await created.json()) as RuleView
    expect(rule).toMatchObject({ version: 1, author: 'header:member', canEdit: true })

    const edited = (await (
      await send(
        app,
        'PUT',
        `/api/rules/${rule.id}`,
        {
          ...ruleBody,
          body: 'Gear names end with the tooth count.',
          files: ['src/gears/**'],
          version: 1,
        },
        as('member'),
      )
    ).json()) as RuleView
    expect(edited).toMatchObject({
      version: 2,
      files: ['src/gears/**'],
      updatedBy: 'header:member',
    })

    const stale = await send(
      app,
      'PUT',
      `/api/rules/${rule.id}`,
      { ...ruleBody, version: 1 },
      as('member'),
    )
    expect(stale.status).toBe(409)

    const detail = (await (
      await send(app, 'GET', `/api/rules/${rule.id}`, undefined, as('reader'))
    ).json()) as RuleDetail
    expect(detail.rule.canEdit).toBe(false)
    expect(detail.history.map((revision) => revision.version)).toEqual([1])

    expect(
      (await send(app, 'DELETE', `/api/rules/${rule.id}`, undefined, as('reader'))).status,
    ).toBe(403)
    expect(
      (await send(app, 'DELETE', `/api/rules/${rule.id}`, undefined, as('member'))).status,
    ).toBe(204)
    expect((await send(app, 'GET', `/api/rules/${rule.id}`, undefined, as('member'))).status).toBe(
      404,
    )
    const actions = (await store.audit.list()).events
      .filter((event) => event.outcome === 'ok')
      .map((event) => event.action)
      .toSorted()
    expect(actions).toEqual(['rule.create', 'rule.delete', 'rule.update'])
  })

  test('writes outside the caller scope are refused, also when an edit moves the scope', async () => {
    const app = setup(teams)
    expect(
      (
        await send(
          app,
          'POST',
          '/api/rules',
          { ...ruleBody, scope: { teams: ['belts'] } },
          as('member'),
        )
      ).status,
    ).toBe(403)
    expect(
      (await send(app, 'POST', '/api/rules', { ...ruleBody, scope: {} }, as('member'))).status,
    ).toBe(400)
    const rule = (await (
      await send(app, 'POST', '/api/rules', ruleBody, as('member'))
    ).json()) as RuleView
    expect(
      (
        await send(
          app,
          'PUT',
          `/api/rules/${rule.id}`,
          { ...ruleBody, scope: { all: true } },
          as('member'),
        )
      ).status,
    ).toBe(403)
  })

  test('lists readable rules, filtered by team, repository and text', async () => {
    const app = setup()
    await send(app, 'POST', '/api/rules', ruleBody)
    await send(app, 'POST', '/api/rules', {
      title: 'Belts stay tensioned',
      body: 'Check belt tension in every pulley change.',
      scope: { repos: ['work:belts/*'] },
    })
    await send(app, 'POST', '/api/rules', {
      title: 'Every repository has a changelog',
      body: 'Keep CHANGELOG.md current.',
      scope: { all: true },
    })
    const titles = async (query: string, headers: Record<string, string> = {}) =>
      (
        (await (
          await send(app, 'GET', `/api/rules${query}`, undefined, headers)
        ).json()) as RuleList
      ).rules.map((rule) => rule.title)
    expect(await titles('')).toEqual([
      'Belts stay tensioned',
      'Every repository has a changelog',
      'Name gears by tooth count',
    ])
    expect(await titles('?team=gears')).toEqual([
      'Every repository has a changelog',
      'Name gears by tooth count',
    ])
    expect(await titles('?repo=work:belts/pulley')).toEqual([
      'Belts stay tensioned',
      'Every repository has a changelog',
    ])
    expect(await titles('?text=tension')).toEqual(['Belts stay tensioned'])
    const readerApp = setup(teams)
    const reader = (await (
      await send(readerApp, 'GET', '/api/rules', undefined, as('reader'))
    ).json()) as RuleList
    expect(reader.rules.map((rule) => rule.title)).toEqual(['Name gears by tooth count'])
    expect(reader.canCreate).toBe(false)
  })

  test('the effective rules of a repository combine panel rules, repository files and learnings', async () => {
    const app = setup()
    await send(app, 'POST', '/api/rules', ruleBody)
    await store.learnings.put({
      id: 'l1',
      text: 'Prefer metric gear sizes.',
      key: 'prefer metric gear sizes',
      scope: { repos: ['work:gears/drive'] },
      origin: 'reply',
      status: 'active',
      sources: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      activeAt: '2026-11-01T00:00:00.000Z',
      lastReinforcedAt: '2026-11-01T00:00:00.000Z',
      uses: 0,
      actedOn: 0,
      votesUp: 0,
      votesDown: 0,
    })
    const effective = (await (
      await send(
        app,
        'GET',
        '/api/rules/effective?repo=work:gears/drive&agent=review&files=src/sprockets/a.ts',
      )
    ).json()) as EffectiveRules
    expect(effective).toMatchObject({ repo: 'work:gears/drive', agent: 'review' })
    expect(effective.blocks.map((block) => [block.layer, block.id])).toEqual([
      ['rule', expect.any(String)],
      ['repo-file', 'AGENTS.md'],
      ['repo-file', 'src/sprockets/AGENTS.md'],
      ['learning', 'learnings'],
    ])
    expect(effective.text).toContain('[learn:l1]')

    const unrelated = (await (
      await send(app, 'GET', '/api/rules/effective?repo=work:gears/drive&files=docs/a.md')
    ).json()) as EffectiveRules
    expect(unrelated.blocks.map((block) => block.id)).not.toContain('src/sprockets/AGENTS.md')

    const readerApp = setup(teams)
    expect(
      (
        await send(
          readerApp,
          'GET',
          '/api/rules/effective?repo=work:belts/pulley',
          undefined,
          as('reader'),
        )
      ).status,
    ).toBe(403)
    expect((await send(app, 'GET', '/api/rules/effective?repo=nope')).status).toBe(400)
  })
})
