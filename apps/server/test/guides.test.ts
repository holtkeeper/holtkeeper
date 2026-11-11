import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  Family,
  FamilyList,
  FamilySuggestionList,
  GuidePreview,
  GuideScopeView,
  GuideSection,
  GuideSectionDetail,
  Job,
} from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    shop: { forge: 'work', include: ['shop/*'] },
  },
})

let store: Store
let clock = 0
const setup = (auth: AuthProvider = noAuth()) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(Date.UTC(2026, 10, 1, 12, clock++)),
  })
}

const teams = headerAuth({
  roles: {
    member: [{ scope: { groups: ['games'] }, actions: ['knowledge:read', 'knowledge:write'] }],
    lead: [
      {
        scope: { groups: ['games'] },
        actions: ['knowledge:read', 'knowledge:write', 'settings:write', 'repos:read'],
      },
    ],
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

const put = (
  app: ReturnType<typeof setup>,
  scope: string,
  section: string,
  body: unknown,
  headers: Record<string, string> = {},
) => send(app, 'PUT', `/api/guide/section?scope=${scope}&section=${section}`, body, headers)

beforeEach(() => {
  store = memoryStore()
})

const pkg = (name: string) => ({
  name,
  versions: ['1.0.0'],
  ranges: ['^1.0.0'],
  workspaces: ['.'],
  count: 1,
  files: 1,
  exports: [],
})

describe('guide sections', () => {
  test('editing needs settings:write for all, groups and families, knowledge:write for repos', async () => {
    const app = setup(teams)
    const member = as('member')
    const lead = as('lead')
    expect((await put(app, 'repo:work:games/a', 'general', { rules: 'R' }, member)).status).toBe(
      200,
    )
    expect((await put(app, 'repo:work:shop/b', 'general', { rules: 'R' }, member)).status).toBe(403)
    expect((await put(app, 'group:games', 'general', { rules: 'G' }, member)).status).toBe(403)
    expect((await put(app, 'group:games', 'general', { rules: 'G' }, lead)).status).toBe(200)
    expect((await put(app, 'group:shop', 'general', { rules: 'G' }, lead)).status).toBe(403)
    expect((await put(app, 'all', 'general', { rules: 'A' }, lead)).status).toBe(403)
    expect((await put(setup(), 'all', 'general', { rules: 'A' })).status).toBe(200)
    const denied = (await store.audit.list({ outcome: 'denied' })).events
    expect(denied.length).toBe(4)
    expect(denied.find((e) => e.target.id === 'repo:work:shop/b/general')?.target).toEqual({
      type: 'guide',
      id: 'repo:work:shop/b/general',
    })
    expect(await store.audit.count({ repo: 'work:shop/b' })).toBe(0)
    expect(await store.audit.count({ repo: 'work:games/a' })).toBe(1)

    const view = (await (
      await app.request('/api/guide?scope=group:games', { headers: member })
    ).json()) as GuideScopeView
    expect(view).toMatchObject({ scope: 'group:games', label: 'Team games', canEdit: false })
    expect(view.sections.map((s) => s.section)).toEqual([
      'general',
      'review',
      'testing',
      'testids',
      'assets',
      'commits',
      'releases',
    ])
    expect(view.sections[0]).toMatchObject({ rules: 'G', version: 1, editedBy: 'header:lead' })
    expect(view.sections[1]).toMatchObject({ rules: '', version: 0 })
    expect((await app.request('/api/guide?scope=all', { headers: member })).status).toBe(200)
    expect((await app.request('/api/guide?scope=group:shop', { headers: member })).status).toBe(403)

    for (const [path, status] of [
      ['/api/guide?scope=team:x', 400],
      ['/api/guide?scope=group:nope', 404],
      ['/api/guide?scope=family:nope', 404],
      ['/api/guide/section?scope=all&section=nope', 400],
    ] as const)
      expect((await setup().request(path)).status).toBe(status)
  })

  test('revisions, restore, version conflicts and audit entries', async () => {
    const app = setup()
    const first = (await (
      await put(app, 'repo:work:games/a', 'review', { rules: 'Flag raw SQL.' })
    ).json()) as GuideSection
    expect(first.version).toBe(1)
    await put(app, 'repo:work:games/a', 'review', {
      rules: 'Flag raw SQL and string-built queries.',
      steering: 'Ignore legacy/.',
      version: 1,
    })
    expect(
      (await put(app, 'repo:work:games/a', 'review', { rules: 'Stale.', version: 1 })).status,
    ).toBe(409)

    const detail = (await (
      await app.request('/api/guide/section?scope=repo:work:games/a&section=review')
    ).json()) as GuideSectionDetail
    expect(detail.section).toMatchObject({ version: 2, steering: 'Ignore legacy/.' })
    expect(detail.history.map((r) => [r.version, r.rules])).toEqual([[1, 'Flag raw SQL.']])
    expect(detail.canEdit).toBe(true)
    expect(detail.people).toEqual({})

    const restored = await send(
      app,
      'POST',
      '/api/guide/section/restore?scope=repo:work:games/a&section=review&version=1',
    )
    expect(((await restored.json()) as GuideSection).rules).toBe('Flag raw SQL.')
    expect(
      (
        await send(
          app,
          'POST',
          '/api/guide/section/restore?scope=repo:work:games/a&section=review&version=9',
        )
      ).status,
    ).toBe(404)

    const events = (await store.audit.list({ action: 'guide.' })).events.toReversed()
    expect(events.map((e) => [e.action, e.outcome])).toEqual([
      ['guide.update', 'ok'],
      ['guide.update', 'ok'],
      ['guide.update', 'error'],
      ['guide.restore', 'ok'],
      ['guide.restore', 'error'],
    ])
    expect(events[1]).toMatchObject({
      target: { type: 'guide', id: 'repo:work:games/a/review', repo: 'work:games/a' },
      details: { version: 2 },
    })
    expect(events[1]?.changes).toContainEqual({
      field: 'steering',
      before: '',
      after: 'Ignore legacy/.',
    })
  })
})

describe('effective prompt preview', () => {
  test('resolves rules of every scope in precedence order with the budget', async () => {
    const app = setup()
    await put(app, 'all', 'general', { rules: 'ALL rule.' })
    await put(app, 'group:games', 'review', { rules: 'GAMES rule.' })
    await put(app, 'repo:work:games/a', 'general', { rules: 'REPO rule.' })
    await put(app, 'repo:work:games/a', 'releases', { rules: 'RELEASE rule.' })
    const preview = (await (
      await app.request('/api/guide/preview?repo=work:games/a&task=review')
    ).json()) as GuidePreview
    expect(preview).toMatchObject({ repo: 'work:games/a', task: 'review', warnings: [] })
    const at = (text: string) => preview.text.indexOf(text)
    expect(at('REPO rule.')).toBeGreaterThan(0)
    expect(at('REPO rule.')).toBeLessThan(at('GAMES rule.'))
    expect(at('GAMES rule.')).toBeLessThan(at('ALL rule.'))
    expect(preview.text).not.toContain('RELEASE rule.')
    expect(preview.budget).toMatchObject({ total: 12_000, used: preview.text.length })

    const notes = (await (
      await app.request('/api/guide/preview?repo=work:games/a&task=release-notes')
    ).json()) as GuidePreview
    expect(notes.text).toContain('RELEASE rule.')
    expect((await app.request('/api/guide/preview?repo=work:games/a&task=x')).status).toBe(400)
    expect((await app.request('/api/guide/preview?task=review')).status).toBe(400)
    expect(
      (
        await setup(teams).request('/api/guide/preview?repo=work:shop/b', {
          headers: as('member'),
        })
      ).status,
    ).toBe(403)
  })
})

const layer = (body: string, status: 'proposed' | 'accepted') => ({
  body,
  inputHash: `hash:${body}`,
  model: 'model-main',
  costUsd: 0.02,
  status,
  generatedAt: '2026-11-01T10:00:00.000Z',
})
const accept = (app: ReturnType<typeof setup>, body: unknown, headers = {}) =>
  send(
    app,
    'POST',
    '/api/guide/section/accept?scope=repo:work:games/a&section=general',
    body,
    headers,
  )

describe('generated text', () => {
  test('accepting moves the waiting text into the layer agents see', async () => {
    const app = setup(teams)
    expect((await accept(app, {}, as('member'))).status).toBe(409)
    await store.guides.put({
      scope: 'repo:work:games/a',
      section: 'general',
      rules: '',
      steering: '',
      learnings: [],
      generated: layer('- Run `make test`.', 'accepted'),
      proposal: layer('- Run `make check`.', 'proposed'),
    })
    expect((await accept(app, { inputHash: 'hash:other' }, as('member'))).status).toBe(409)
    expect(
      (
        await send(
          app,
          'POST',
          '/api/guide/section/accept?scope=repo:work:shop/b&section=general',
          {},
          as('member'),
        )
      ).status,
    ).toBe(403)
    expect(
      (await send(app, 'POST', '/api/guide/section/accept?scope=all&section=general', {})).status,
    ).toBe(400)
    const response = await accept(app, { inputHash: 'hash:- Run `make check`.' }, as('member'))
    expect(response.status).toBe(200)
    const section = (await response.json()) as GuideSection
    expect(section.proposal).toBeUndefined()
    expect(section.generated).toMatchObject({
      body: '- Run `make check`.',
      status: 'accepted',
      acceptedBy: 'header:member',
    })
    expect(section.version).toBe(0)
    const [event] = (await store.audit.list({ action: 'guide.accept' })).events
    expect(event?.target).toEqual({
      type: 'guide',
      id: 'repo:work:games/a/general',
      repo: 'work:games/a',
    })
    expect((await accept(app, {}, as('member'))).status).toBe(409)
  })

  test('regenerating queues a forced guide job with the extra prompt', async () => {
    const jobsConfig = parseConfig({
      forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
      groups: { games: { forge: 'work', include: ['games/*'] } },
      jobs: {},
    })
    const runner = headerAuth({
      roles: {
        writer: [{ scope: { groups: ['games'] }, actions: ['knowledge:write'] }],
        runner: [{ scope: { groups: ['games'] }, actions: ['knowledge:write', 'analyses:run'] }],
      },
    })
    const vault = aesVault('v'.repeat(32))
    const app = createApp({
      config: jobsConfig,
      auth: runner,
      store,
      vault,
      credentials: createCredentialService({ credentials: store.credentials, vault }),
      settings: builtinSettings,
      analyses: [],
      analyzers: [{ kind: 'guide', scope: 'repo', options: z.object({}).passthrough() }],
      now: () => new Date(Date.UTC(2026, 10, 1, 12)),
    })
    const regenerate = (body: unknown, role: string, repo = 'work:games/a') =>
      send(app, 'POST', `/api/guide/regenerate?repo=${repo}`, body, as(role))
    expect((await regenerate({}, 'writer')).status).toBe(403)
    expect((await regenerate({ sections: ['review'] }, 'runner')).status).toBe(400)
    const response = await regenerate(
      { sections: ['general'], prompt: 'Mention the build target.' },
      'runner',
    )
    expect(response.status).toBe(201)
    const job = (await response.json()) as Job
    expect(job).toMatchObject({
      analyzer: 'guide',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      actor: 'header:runner',
      options: { force: true, sections: ['general'], prompt: 'Mention the build target.' },
    })
    expect((await regenerate({}, 'runner', 'work:shop/b')).status).toBe(403)
    expect(
      (await send(setup(), 'POST', '/api/guide/regenerate?repo=work:games/a', {})).status,
    ).toBe(409)
  })
})

describe('families', () => {
  test('create, conflicts, permissions, edit and delete with its guide', async () => {
    const app = setup(teams)
    const lead = as('lead')
    const created = await send(
      app,
      'POST',
      '/api/families',
      { name: 'Widget apps', members: ['work:games/a', 'work:games/b'] },
      lead,
    )
    expect(created.status).toBe(201)
    const family = (await created.json()) as Family
    expect(family).toMatchObject({ name: 'Widget apps', createdBy: 'header:lead' })

    const conflict = await send(
      app,
      'POST',
      '/api/families',
      { name: 'Other', members: ['work:games/b', 'work:games/c'] },
      lead,
    )
    expect(conflict.status).toBe(409)
    const foreign = await send(
      app,
      'POST',
      '/api/families',
      { name: 'Mixed', members: ['work:games/c', 'work:shop/d'] },
      lead,
    )
    expect(foreign.status).toBe(403)
    for (const body of [
      { name: 'One', members: ['work:games/x'] },
      { name: 'Dup', members: ['work:games/x', 'work:games/x'] },
      { name: 'Forge', members: ['nope:games/x', 'work:games/y'] },
    ])
      expect((await send(app, 'POST', '/api/families', body, lead)).status).toBe(400)

    const listed = (await (
      await app.request('/api/families', { headers: lead })
    ).json()) as FamilyList
    expect(listed.families.map((f) => f.name)).toEqual(['Widget apps'])
    expect(
      ((await (await app.request('/api/families', { headers: as('member') })).json()) as FamilyList)
        .families,
    ).toEqual([])

    expect(
      (await put(app, `family:${family.id}`, 'general', { rules: 'F' }, as('member'))).status,
    ).toBe(403)
    expect((await put(app, `family:${family.id}`, 'general', { rules: 'F' }, lead)).status).toBe(
      200,
    )
    const preview = (await (
      await app.request('/api/guide/preview?repo=work:games/b', { headers: lead })
    ).json()) as GuidePreview
    expect(preview.text).toContain('## Team rules for the Widget apps family')

    const edited = await send(
      app,
      'PUT',
      `/api/families/${family.id}`,
      { name: 'Widgets', members: ['work:games/a', 'work:games/c'] },
      lead,
    )
    expect(((await edited.json()) as Family).members).toEqual(['work:games/a', 'work:games/c'])
    expect(
      (
        await send(
          app,
          'PUT',
          `/api/families/${family.id}`,
          { name: 'Widgets', members: ['work:games/a', 'work:shop/d'] },
          lead,
        )
      ).status,
    ).toBe(403)

    expect((await send(app, 'DELETE', `/api/families/${family.id}`, undefined, lead)).status).toBe(
      204,
    )
    expect(await store.families.list()).toEqual([])
    expect(await store.guides.list({ scopes: [`family:${family.id}`] })).toEqual([])
    const actions = (await store.audit.list({ action: 'family.', outcome: 'ok' })).events
    expect(actions.map((e) => e.action).toReversed()).toEqual([
      'family.create',
      'family.update',
      'family.delete',
    ])
  })

  test('suggestions come from usage and stack records and skip repos already in families', async () => {
    const usages = async (path: string, names: string[], local: string[] = []) =>
      store.analyses.add({
        repo: { forge: 'work', path },
        kind: 'usages',
        createdAt: '2026-11-01T10:00:00.000Z',
        data: {
          packages: [...names.map(pkg), ...local.map((name) => ({ ...pkg(name), local: true }))],
          files: 3,
          types: { status: 'skipped' },
        },
      })
    const shared = ['react', 'react-dom', 'widget-kit', 'shape-utils']
    await usages('games/a', shared, ['own-a'])
    await usages('games/b', shared, ['own-b'])
    await usages('games/c', [...shared, 'extra'])
    await usages('shop/d', shared)
    await usages('games/z', ['commander'])
    await store.analyses.add({
      repo: { forge: 'work', path: 'games' },
      kind: 'stack',
      createdAt: '2026-11-01T10:00:00.000Z',
      data: {
        components: [
          {
            id: 'node',
            kind: 'runtime',
            usages: ['games/a', 'games/b', 'games/c', 'games/z'].map((repo) => ({ repo })),
          },
          { id: 'pnpm', kind: 'package-manager', usages: [{ repo: 'games/c' }] },
        ],
      },
    })
    const app = setup(teams)
    const lead = as('lead')
    const first = (await (
      await app.request('/api/families/suggestions', { headers: lead })
    ).json()) as FamilySuggestionList
    expect(first.suggestions).toEqual([
      {
        name: 'games (react)',
        members: ['work:games/a', 'work:games/b'],
        similarity: 1,
        framework: 'react',
        toolchain: ['node'],
        shared: ['react', 'react-dom', 'shape-utils', 'widget-kit'],
      },
    ])
    const dismiss = (members: string[], headers = lead) =>
      send(app, 'POST', '/api/families/suggestions/dismiss', { members }, headers)
    expect((await dismiss(['work:games/b', 'work:games/a'], as('member'))).status).toBe(403)
    expect((await dismiss(['work:games/b'])).status).toBe(400)
    expect((await dismiss(['work:games/b', 'work:games/a'])).status).toBe(204)
    expect((await dismiss(['work:games/a', 'work:games/b'])).status).toBe(204)
    expect(await store.kv?.get('families:dismissed-suggestions')).toEqual([
      'work:games/a,work:games/b',
    ])
    const afterDismiss = (await (
      await setup(teams).request('/api/families/suggestions', { headers: lead })
    ).json()) as FamilySuggestionList
    expect(afterDismiss.suggestions).toEqual([])
    expect(
      (await store.audit.list({ action: 'family.suggestion_dismiss', outcome: 'ok' })).events,
    ).toHaveLength(2)
    await store.kv?.delete('families:dismissed-suggestions')
    await store.families.put({
      id: 'f1',
      name: 'Taken',
      members: ['work:games/a'],
      createdBy: 'root',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    })
    const second = (await (
      await app.request('/api/families/suggestions', { headers: lead })
    ).json()) as FamilySuggestionList
    expect(second.suggestions).toEqual([])
  })
})

test('the Guide names the users who edited its sections and their revisions', async () => {
  await store.users.putUser({
    id: 'root',
    name: 'Ann',
    grants: [],
    disabled: false,
    sessionVersion: 0,
    createdAt: '2026-10-30T00:00:00.000Z',
    avatarSeed: 'fox',
  })
  const app = setup()
  await app.request('/api/guide/section?scope=all&section=general', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: 'Prefer fooUtil.' }),
  })
  const view = (await (await app.request('/api/guide?scope=all')).json()) as GuideScopeView
  expect(view.sections.find((s) => s.section === 'general')?.editedBy).toBe('root')
  expect(view.people).toEqual({ root: { name: 'Ann', avatarUrl: '/api/avatars/fox.svg' } })
  const detail = (await (
    await app.request('/api/guide/section?scope=all&section=general')
  ).json()) as GuideSectionDetail
  expect(Object.keys(detail.people)).toEqual(['root'])
})
