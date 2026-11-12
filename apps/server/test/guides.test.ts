import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  Family,
  FamilyList,
  FamilySuggestionList,
  GuideChainView,
  GuideGeneratedHistory,
  GuidePreview,
  GuideRepoFilesView,
  GuideScopeView,
  GuideSection,
  GuideSectionDetail,
  Job,
  KnowledgeCounts,
} from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { createGuideResolver } from '@holtkeeper/guide'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import { rulesToolset } from '../src/tools/rules.ts'

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
    expect(preview).toMatchObject({ repo: 'work:games/a', task: 'review' })
    expect(preview.warnings).toEqual([
      expect.stringContaining("The repository's rules files could not be read"),
    ])
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

  test('rejecting remembers the version without overwriting it and hides it as waiting', async () => {
    const app = setup(teams)
    const reject = (body: unknown, role: string) =>
      send(app, 'POST', '/api/guide/section/reject', body, as(role))
    const waiting = layer('- Run `make check`.', 'proposed')
    await store.guides.put({
      scope: 'repo:work:games/a',
      section: 'general',
      rules: '',
      steering: '',
      learnings: [],
      generated: layer('- Run `make test`.', 'accepted'),
      proposal: { ...waiting, generatedAt: '2026-11-01T11:00:00.000Z' },
    })
    const body = { scope: 'repo:work:games/a', section: 'general', inputHash: waiting.inputHash }
    expect((await reject({ ...body, scope: 'repo:work:shop/b' }, 'member')).status).toBe(403)
    expect((await reject({ ...body, scope: 'group:games' }, 'lead')).status).toBe(400)
    expect((await reject({ ...body, inputHash: 'hash:other' }, 'member')).status).toBe(409)

    const response = await reject(body, 'member')
    expect(response.status).toBe(200)
    const section = (await response.json()) as GuideSection
    expect(section.proposal).toBeUndefined()
    expect(section.generated?.body).toBe('- Run `make test`.')

    const stored = await store.guides.get('repo:work:games/a', 'general')
    expect(stored?.proposal?.inputHash).toBe(waiting.inputHash)
    expect(await store.kv!.get('guide:rejected:repo:work:games/a:general')).toEqual([
      {
        inputHash: waiting.inputHash,
        generatedAt: '2026-11-01T11:00:00.000Z',
        by: 'header:member',
        at: expect.any(String),
      },
    ])
    const [event] = (await store.audit.list({ action: 'guide.reject', outcome: 'ok' })).events
    expect(event?.target).toEqual({
      type: 'guide',
      id: 'repo:work:games/a/general',
      repo: 'work:games/a',
    })
    expect(event?.details).toMatchObject({
      inputHash: waiting.inputHash,
      generatedAt: '2026-11-01T11:00:00.000Z',
    })
    expect(
      (await store.audit.list({ action: 'guide.reject', outcome: 'denied' })).events,
    ).toHaveLength(1)

    const view = (await (
      await send(
        app,
        'GET',
        '/api/guide/section?scope=repo:work:games/a&section=general',
        undefined,
        as('member'),
      )
    ).json()) as GuideSectionDetail
    expect(view.section.proposal).toBeUndefined()
    expect((await accept(app, {}, as('member'))).status).toBe(409)
    expect((await reject(body, 'member')).status).toBe(409)
  })

  test('rejecting auto-accepted text puts back what a person accepted before', async () => {
    const app = setup(teams)
    const base = { scope: 'repo:work:games/a' as const, section: 'general' as const }
    const row = { ...base, rules: '', steering: '', learnings: [] }
    const mine = { ...layer('- Run `make test`.', 'accepted'), acceptedBy: 'header:member' }
    await store.guides.put({ ...row, generated: mine })
    const auto = {
      ...layer('- Run `make check`.', 'accepted'),
      generatedAt: '2026-11-02T10:00:00.000Z',
      acceptedBy: 'auto-accept',
    }
    await store.guides.put({ ...row, generated: auto })
    const reject = (inputHash: string) =>
      send(app, 'POST', '/api/guide/section/reject', { ...base, inputHash }, as('member'))
    expect((await reject('hash:- Run `make test`.')).status).toBe(409)

    const response = await reject(auto.inputHash)
    expect(response.status).toBe(200)
    const section = (await response.json()) as GuideSection
    expect(section.generated).toMatchObject({
      body: '- Run `make test`.',
      status: 'accepted',
      acceptedBy: 'header:member',
    })
    expect(await store.kv!.get('guide:rejected:repo:work:games/a:general')).toMatchObject([
      { inputHash: auto.inputHash },
    ])
    const [event] = (await store.audit.list({ action: 'guide.reject', outcome: 'ok' })).events
    expect(event?.details).toMatchObject({ autoAccepted: true })
    expect((await reject(auto.inputHash)).status).toBe(409)
  })

  test('rejecting auto-accepted text with nothing accepted before drops the generated layer', async () => {
    const app = setup(teams)
    const auto = { ...layer('- Run `make check`.', 'accepted'), acceptedBy: 'auto-accept' }
    await store.guides.put({
      scope: 'repo:work:games/a',
      section: 'testing',
      rules: '',
      steering: '',
      learnings: [],
      generated: auto,
    })
    const response = await send(
      app,
      'POST',
      '/api/guide/section/reject',
      { scope: 'repo:work:games/a', section: 'testing', inputHash: auto.inputHash },
      as('member'),
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as GuideSection).generated).toBeUndefined()
    expect((await store.guides.get('repo:work:games/a', 'testing'))?.generated).toBeUndefined()
  })

  test('a rejected first proposal no longer shows as the generated layer', async () => {
    const app = setup(teams)
    const waiting = layer('- Run `make check`.', 'proposed')
    await store.guides.put({
      scope: 'repo:work:games/a',
      section: 'testing',
      rules: '',
      steering: '',
      learnings: [],
      generated: waiting,
    })
    const response = await send(
      app,
      'POST',
      '/api/guide/section/reject',
      { scope: 'repo:work:games/a', section: 'testing', inputHash: waiting.inputHash },
      as('member'),
    )
    expect(response.status).toBe(200)
    const scope = (await (
      await send(app, 'GET', '/api/guide?scope=repo:work:games/a', undefined, as('member'))
    ).json()) as GuideScopeView
    expect(scope.sections.find((s) => s.section === 'testing')?.generated).toBeUndefined()
    expect((await store.guides.get('repo:work:games/a', 'testing'))?.generated).toEqual({
      ...waiting,
      version: 1,
    })
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

const filesForge = (files: Record<string, string>) => {
  const reads: string[] = []
  return {
    reads,
    forge: {
      headCommit: async () => 'a41c9e2',
      readFile: async (repo: string, file: string, ref?: string) => {
        reads.push(`${repo}/${file}@${ref ?? ''}`)
        return files[file]
      },
    },
  }
}

const setupWithForge = (forge: unknown, auth: AuthProvider = noAuth()) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config: parseConfig({
      forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => forge as never } },
      groups: {
        games: { forge: 'work', include: ['games/*'] },
        web: { forge: 'work', include: ['games/a'] },
        shop: { forge: 'work', include: ['shop/*'] },
      },
    }),
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(Date.UTC(2026, 10, 1, 12, clock++)),
  })
}

const json = async <T>(response: Response | Promise<Response>) => (await response).json() as T

describe('guide chain and repository files', () => {
  test('layers per section in agent reading order with several groups and the budget', async () => {
    const { forge } = filesForge({
      'REVIEW.md': 'Flag raw fooUtil calls.',
      'AGENTS.md': 'Run checks.',
    })
    const app = setupWithForge(forge)
    const family = await json<Family>(
      send(app, 'POST', '/api/families', {
        name: 'Widget apps',
        members: ['work:games/a', 'work:games/b'],
      }),
    )
    await put(app, 'all', 'review', { rules: 'ALL review.' })
    await put(app, 'group:web', 'review', { rules: 'WEB review.' })
    await put(app, 'group:games', 'review', { rules: 'GAMES review.' })
    await put(app, `family:${family.id}`, 'review', { rules: 'FAMILY review.' })
    await put(app, 'repo:work:games/a', 'review', { rules: 'REPO review.' })
    await store.guides.put({
      ...(await store.guides.get('repo:work:games/a', 'review'))!,
      generated: { ...layer('- Generated review line.', 'accepted') },
    })

    const chain = await json<GuideChainView>(
      app.request('/api/guide/chain?repo=work:games/a&section=review'),
    )
    expect(chain.repo).toBe('work:games/a')
    expect(chain.sections.map((s) => s.section)).toEqual(['review'])
    const layers = chain.sections[0]?.layers ?? []
    expect(layers.map((l) => [l.n, l.kind, l.source])).toEqual([
      [1, 'repo-file', 'REVIEW.md · AGENTS.md'],
      [2, 'repo', 'This repository'],
      [3, 'family', 'Family Widget apps'],
      [4, 'group', 'Team games'],
      [5, 'group', 'Team web'],
      [6, 'all', 'All repositories'],
      [7, 'generated', 'Generated Review'],
    ])
    expect(layers[6]).toMatchObject({ version: 1 })
    expect(layers[0]?.text).toContain('Flag raw fooUtil calls.')
    expect(chain.budget).toMatchObject({ total: 12_000, human: 8_000, generated: 4_000 })
    expect(chain.budget.used).toBeGreaterThan(0)
    expect(chain.warnings).toEqual([])

    const all = await json<GuideChainView>(app.request('/api/guide/chain?repo=work:games/a'))
    expect(all.sections).toHaveLength(7)
    expect((await app.request('/api/guide/chain?repo=work:games/a&section=x')).status).toBe(400)
    expect((await app.request('/api/guide/chain')).status).toBe(400)
  })

  test('repository files are read at the head sha, cached by it, and need knowledge:read', async () => {
    const { forge, reads } = filesForge({ 'AGENTS.md': 'Run checks.\n', 'REVIEW.md': 'Flag it.' })
    const app = setupWithForge(forge, teams)
    const view = await json<GuideRepoFilesView>(
      app.request('/api/guide/repo-files?repo=work:games/a', { headers: as('member') }),
    )
    expect(view.files.map((f) => [f.path, f.chars])).toEqual([
      ['REVIEW.md', 8],
      ['AGENTS.md', 11],
    ])
    expect(view.files[0]?.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(view.sha).toBe('a41c9e2')
    expect(reads.every((read) => read.endsWith('@a41c9e2'))).toBe(true)
    const count = reads.length
    await app.request('/api/guide/repo-files?repo=work:games/a', { headers: as('member') })
    expect(reads).toHaveLength(count)
    expect(
      (await app.request('/api/guide/repo-files?repo=work:shop/b', { headers: as('member') }))
        .status,
    ).toBe(403)
    expect(
      (await app.request('/api/guide/chain?repo=work:shop/b', { headers: as('member') })).status,
    ).toBe(403)
  })

  test('the effective prompt preview starts with the repository files', async () => {
    const { forge } = filesForge({ 'REVIEW.md': 'Flag raw fooUtil calls.' })
    const app = setupWithForge(forge)
    await put(app, 'all', 'review', { rules: 'ALL review.' })
    const preview = await json<GuidePreview>(
      app.request('/api/guide/preview?repo=work:games/a&task=review'),
    )
    expect(preview.blocks[0]).toMatchObject({ layer: 'repo-file', source: 'REVIEW.md' })
    expect(preview.text).toContain('Flag raw fooUtil calls.')
    expect(preview.budget.used).toBe(preview.text.length)
    expect(preview.warnings).toEqual([])
  })

  test('an unreadable forge leaves the files out of the chain with a warning', async () => {
    const app = setupWithForge({
      readFile: async () => {
        throw new Error('forge down')
      },
    })
    await put(app, 'all', 'general', { rules: 'ALL.' })
    const chain = await json<GuideChainView>(
      app.request('/api/guide/chain?repo=work:games/a&section=general'),
    )
    expect(chain.sections[0]?.layers.map((l) => l.kind)).toEqual(['all'])
    expect(chain.warnings[0]).toContain('forge down')
    expect((await app.request('/api/guide/repo-files?repo=work:games/a')).status).toBe(502)
  })

  test('repo_rules lists the layers in the same order as the chain', async () => {
    const { forge } = filesForge({})
    const app = setupWithForge(forge)
    await put(app, 'all', 'testing', { rules: 'ALL testing.' })
    await put(app, 'group:games', 'testing', { rules: 'GAMES testing.' })
    await put(app, 'group:web', 'testing', { rules: 'WEB testing.' })
    await put(app, 'repo:work:games/a', 'testing', { rules: 'REPO testing.' })
    const chain = await json<GuideChainView>(
      app.request('/api/guide/chain?repo=work:games/a&section=testing'),
    )
    const resolve = createGuideResolver({ store })
    const rules = rulesToolset({
      guide: {
        resolve: (_repo, request) =>
          resolve({
            repo: { forge: 'work', path: 'games/a', groups: ['games', 'web'] },
            ...request,
          }),
      },
    })
    const tool = rules?.tools.find((t) => t.name === 'repo_rules')
    const text = String(await tool?.run({ repo: 'work:games/a', only: 'testing' }, {} as never))
    const listed = text
      .split('\n')
      .filter((line) => /^\d+\. /.test(line))
      .map((line) => line.replace(/ \(.*$/, ''))
    expect(listed).toEqual((chain.sections[0]?.layers ?? []).map((l) => `${l.n}. ${l.source}`))
    expect(listed).toEqual([
      '1. This repository',
      '2. Team games',
      '3. Team web',
      '4. All repositories',
    ])
  })
})

describe('generated history', () => {
  test('every stored version newest first, marked current and rejected', async () => {
    const app = setup(teams)
    await store.guides.put({
      scope: 'repo:work:games/a',
      section: 'general',
      rules: '',
      steering: '',
      learnings: [],
      generated: layer('- First.', 'proposed'),
    })
    const first = (await store.guides.get('repo:work:games/a', 'general'))!
    await store.guides.put({
      ...first,
      generated: { ...first.generated!, status: 'accepted', acceptedBy: 'header:member' },
    })
    await store.guides.put({
      ...(await store.guides.get('repo:work:games/a', 'general'))!,
      proposal: { ...layer('- Second.', 'proposed'), generatedAt: '2026-11-02T10:00:00.000Z' },
    })
    const waiting = (await store.guides.get('repo:work:games/a', 'general'))!.proposal!
    await send(
      app,
      'POST',
      '/api/guide/section/reject',
      { scope: 'repo:work:games/a', section: 'general', inputHash: waiting.inputHash },
      as('member'),
    )
    const history = await json<GuideGeneratedHistory>(
      app.request('/api/guide/generated/history?scope=repo:work:games/a&section=general', {
        headers: as('member'),
      }),
    )
    expect(history.versions.map((v) => [v.version, v.body, v.current, v.rejected])).toEqual([
      [2, '- Second.', 'proposal', true],
      [1, '- First.', 'generated', false],
    ])
    expect(history.versions[1]?.acceptedBy).toBe('header:member')
    expect(
      (
        await app.request('/api/guide/generated/history?scope=repo:work:shop/b&section=general', {
          headers: as('member'),
        })
      ).status,
    ).toBe(403)
  })
})

const note = (id: string, scope: object) =>
  store.knowledge.put({
    id,
    title: `Note ${id}`,
    body: 'Use ShapeBase.',
    kind: 'convention',
    scope,
    topics: [],
    appliesTo: ['*'],
    status: 'accepted',
    evidence: [],
    source: 'human',
    author: 'jane',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  })

const candidate = (id: string, repo: string) =>
  store.learnings.put({
    id,
    repo,
    rule: `Rule ${id}.`,
    key: `rule ${id}`,
    section: 'review',
    suggestedScope: 'repo',
    status: 'proposed',
    sources: [],
    model: 'none',
    costUsd: 0,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  })

describe('knowledge counts', () => {
  test('counts guide sections, notes and proposed learnings per space, narrowed to the grant', async () => {
    const app = setup()
    await put(app, 'all', 'general', { rules: 'ALL.' })
    await put(app, 'group:games', 'review', { rules: 'GAMES.' })
    await put(app, 'group:shop', 'review', { rules: 'SHOP.' })
    await put(app, 'repo:work:games/a', 'testing', { rules: 'A.' })
    await put(app, 'repo:work:shop/b', 'testing', { rules: 'B.' })
    await note('n1', { groups: ['games'] })
    await note('n2', { repos: ['work:shop/b'] })
    await note('n3', { all: true })
    await candidate('c1', 'work:games/a')
    await candidate('c2', 'work:shop/b')

    const everything = await json<KnowledgeCounts>(app.request('/api/knowledge/counts'))
    expect(everything.spaces).toEqual({
      all: { guide: 1, notes: 3, learnings: 2 },
      'group:games': { guide: 1, notes: 1, learnings: 1 },
      'group:shop': { guide: 1, notes: 0, learnings: 1 },
      'repo:work:games/a': { guide: 1, notes: 2, learnings: 1 },
      'repo:work:shop/b': { guide: 1, notes: 2, learnings: 1 },
    })

    const narrow = await json<KnowledgeCounts>(
      setup(teams).request('/api/knowledge/counts', { headers: as('member') }),
    )
    expect(narrow.spaces).toEqual({
      all: { guide: 1, notes: 1, learnings: 1 },
      'group:games': { guide: 1, notes: 1, learnings: 1 },
      'repo:work:games/a': { guide: 1, notes: 2, learnings: 1 },
    })
  })

  test('counts notes the way the Notes table lists them: live ones, families by member', async () => {
    const app = setup()
    await store.families.put({
      id: 'f1',
      name: 'Widget apps',
      members: ['work:games/a', 'work:shop/b'],
      createdBy: 'jane',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    })
    await note('n1', { repos: ['work:games/a'] })
    await note('n2', { all: true })
    await note('n3', { groups: ['shop'] })
    await store.knowledge.put({
      ...(await store.knowledge.get('n3'))!,
      id: 'n4',
      scope: { repos: ['work:shop/b'] },
      status: 'proposed',
    })
    await store.knowledge.put({
      ...(await store.knowledge.get('n3'))!,
      id: 'n5',
      status: 'rejected',
    })
    const counts = await json<KnowledgeCounts>(app.request('/api/knowledge/counts'))
    expect(counts.spaces['all']?.notes).toBe(4)
    expect(counts.spaces['family:f1']?.notes).toBe(2)
    expect(counts.spaces['group:shop']?.notes).toBe(1)
    expect(counts.spaces['repo:work:shop/b']?.notes).toBe(3)
  })
})

describe('subgroups', () => {
  const nested = parseConfig({
    forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
    groups: {
      shapes: { forge: 'work', include: ['shapes/*'], title: 'Shapes' },
      'shapes.round': { forge: 'work', include: ['shapes/disc*'], title: 'Round' },
    },
  })
  const nestedApp = (auth: AuthProvider = noAuth()) => {
    const vault = aesVault('v'.repeat(32))
    return createApp({
      config: nested,
      auth,
      store,
      vault,
      credentials: createCredentialService({ credentials: store.credentials, vault }),
      settings: builtinSettings,
      analyses: [],
      now: () => new Date(Date.UTC(2026, 10, 1, 12, clock++)),
    })
  }
  const grants = headerAuth({
    roles: {
      round: [{ scope: { groups: ['shapes.round'] }, actions: ['knowledge:read'] }],
      shapes: [{ scope: { groups: ['shapes'] }, actions: ['knowledge:read'] }],
    },
  })

  test('the chain shows the subgroup layer before its parent, with path titles', async () => {
    const app = nestedApp()
    await put(app, 'group:shapes', 'review', { rules: 'PARENT review.' })
    await put(app, 'group:shapes.round', 'review', { rules: 'SUB review.' })
    const chain = await json<GuideChainView>(
      app.request('/api/guide/chain?repo=work:shapes/disc&section=review'),
    )
    expect(chain.sections[0]?.layers.map((l) => [l.kind, l.scope, l.source])).toEqual([
      ['subgroup', 'group:shapes.round', 'Team Shapes › Round (shapes.round)'],
      ['group', 'group:shapes', 'Team Shapes (shapes)'],
    ])
    const flat = await json<GuideChainView>(
      app.request('/api/guide/chain?repo=work:shapes/cube&section=review'),
    )
    expect(flat.sections[0]?.layers.map((l) => l.scope)).toEqual(['group:shapes'])
  })

  test('counts give a subgroup its own space, readable from its own or its parent grant', async () => {
    const app = nestedApp()
    await put(app, 'group:shapes', 'review', { rules: 'PARENT.' })
    await put(app, 'group:shapes.round', 'review', { rules: 'SUB.' })
    await note('n1', { groups: ['shapes.round'] })
    await note('n2', { groups: ['shapes'] })
    await candidate('c1', 'work:shapes/disc')

    const everything = await json<KnowledgeCounts>(app.request('/api/knowledge/counts'))
    expect(everything.spaces).toEqual({
      all: { guide: 0, notes: 2, learnings: 1 },
      'group:shapes': { guide: 1, notes: 1, learnings: 1 },
      'group:shapes.round': { guide: 1, notes: 1, learnings: 1 },
      'repo:work:shapes/disc': { guide: 0, notes: 2, learnings: 1 },
    })

    const counts = (role: string) =>
      json<KnowledgeCounts>(
        nestedApp(grants).request('/api/knowledge/counts', { headers: as(role) }),
      )
    expect(Object.keys((await counts('round')).spaces).toSorted()).toEqual([
      'all',
      'group:shapes.round',
      'repo:work:shapes/disc',
    ])
    expect((await counts('round')).spaces['group:shapes.round']?.notes).toBe(1)
    expect(Object.keys((await counts('shapes')).spaces).toSorted()).toEqual([
      'all',
      'group:shapes',
      'group:shapes.round',
      'repo:work:shapes/disc',
    ])
  })
})
