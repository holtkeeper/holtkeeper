import { expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { createGuideResolver } from './load.ts'

const position = (text: string, id: string) => text.indexOf(`[kb:${id}]`)

test('createGuideResolver reads family, sections, policies and notes from the store', async () => {
  const store = memoryStore()
  const at = '2026-11-01T10:00:00.000Z'
  await store.families.put({
    id: 'f1',
    name: 'Widgets',
    members: ['work:acme/round/web'],
    createdBy: 'jane',
    createdAt: at,
    updatedAt: at,
  })
  const put = (scope: string, rules: string) =>
    store.guides.put({
      scope: scope as never,
      section: 'general',
      rules,
      steering: '',
      editedBy: 'jane',
      editedAt: at,
      learnings: [],
    })
  await put('family:f1', 'Family rule.')
  await put('team:widgets', 'Team rule.')
  await put('path:work:acme/round', 'Folder rule.')
  await store.settings.put({
    id: 's1',
    key: 'commits.conventions',
    scope: { all: true },
    value: { commit: { maxLength: 72 } },
    secret: false,
    updatedAt: at,
  })
  await store.knowledge.put({
    id: 'k1',
    title: 'Widget registry',
    body: 'Register widgets once.',
    kind: 'convention',
    scope: { all: true },
    topics: [],
    appliesTo: ['release-notes'],
    status: 'accepted',
    evidence: [],
    source: 'human',
    author: 'jane',
    createdAt: at,
    updatedAt: at,
  })
  const resolve = createGuideResolver({ store })
  const repo = { forge: 'work', path: 'acme/round/web', teams: ['widgets'] }

  const review = await resolve({ repo, task: 'review' })
  expect(review.text).toContain('Family rule.')
  expect(review.text).toContain('Team rule.')
  expect(review.text).toContain('## Rules for folder acme/round')
  expect(review.text).not.toContain('72 characters')
  expect(review.text).not.toContain('[kb:k1]')

  const notes = await resolve({ repo, task: 'release-notes' })
  expect(notes.text).toContain('72 characters')
  expect(notes.text).toContain('[kb:k1]')
  expect((await resolve({ repo, task: 'release-notes', notesChars: 0 })).text).not.toContain(
    '[kb:k1]',
  )

  await store.knowledge.put({
    id: 'k2',
    title: 'Widget names',
    body: 'Name widgets after their shape.',
    kind: 'convention',
    scope: { all: true },
    topics: [],
    appliesTo: ['release-notes'],
    status: 'accepted',
    evidence: [],
    source: 'human',
    author: 'jane',
    createdAt: at,
    updatedAt: at,
  })
  const first = (await resolve({ repo, task: 'release-notes', semantic: new Map([['k1', 0.9]]) }))
    .text
  expect(position(first, 'k1')).toBeLessThan(position(first, 'k2'))
  const second = (await resolve({ repo, task: 'release-notes', semantic: new Map([['k2', 0.9]]) }))
    .text
  expect(position(second, 'k2')).toBeLessThan(position(second, 'k1'))
})

test('a repository with no tests by design reads no testing sections', async () => {
  const store = memoryStore()
  const at = '2026-11-01T10:00:00.000Z'
  for (const section of ['general', 'testing'] as const)
    await store.guides.put({
      scope: 'team:widgets',
      section,
      rules: `${section} rule.`,
      steering: '',
      editedBy: 'jane',
      editedAt: at,
      learnings: [],
    })
  const resolve = createGuideResolver({ store })
  const repo = { forge: 'work', path: 'acme/round/web', teams: ['widgets'] }
  expect((await resolve({ repo, task: 'review' })).text).toContain('testing rule.')

  await store.settings.put({
    id: 's1',
    key: 'repo.tests',
    scope: { teams: ['widgets'] },
    value: { expected: false },
    secret: false,
    updatedAt: at,
  })
  const review = await resolve({ repo, task: 'review' })
  expect(review.text).toContain('general rule.')
  expect(review.text).not.toContain('testing rule.')
  expect(review.text).toContain('This repository has no tests by design: do not add test files')
})

test('teamTitle names team keys and files reach the notes', async () => {
  const store = memoryStore()
  const at = '2026-11-01T10:00:00.000Z'
  await store.guides.put({
    scope: 'team:widgets',
    section: 'general',
    rules: 'Team rule.',
    steering: '',
    editedBy: 'jane',
    editedAt: at,
    learnings: [],
  })
  const resolve = createGuideResolver({ store, teamTitle: (key) => `Widget crew (${key})` })
  const repo = { forge: 'work', path: 'acme/round/web', teams: ['widgets'] }
  const resolved = await resolve({ repo, task: 'review', files: ['src/app.ts'] })
  expect(resolved.text).toContain('## Team rules for team Widget crew (widgets)')
})

test('createGuideResolver adds knowledge of neighbours the caller allows, with their families', async () => {
  const store = memoryStore()
  const at = '2026-11-01T10:00:00.000Z'
  await store.families.put({
    id: 'f-square',
    name: 'Square',
    members: ['work:acme/square/web', 'work:acme/square/app'],
    createdBy: 'jane',
    createdAt: at,
    updatedAt: at,
  })
  const put = (id: string, overrides: Record<string, unknown>) =>
    store.knowledge.put({
      id,
      title: `Note ${id}`,
      body: 'Load sprites lazily.',
      kind: 'convention',
      scope: { repos: ['work:acme/square/web'] },
      topics: [],
      appliesTo: ['*'],
      status: 'accepted',
      evidence: [],
      source: 'human',
      author: 'jane',
      createdAt: at,
      updatedAt: at,
      ...overrides,
    })
  await put('fam', { match: { families: ['f-square'] } })
  await put('secret', {})
  const resolve = createGuideResolver({ store })
  const repo = { forge: 'work', path: 'acme/round/web', teams: ['widgets'] }
  const square = { forge: 'work', path: 'acme/square/web', teams: ['shapes'] }

  const resolved = await resolve({
    repo,
    task: 'review',
    neighbours: { repos: [{ repo: square, similarity: 0.7 }], readable: (e) => e.id !== 'secret' },
  })
  expect(resolved.text).toContain('[kb:fam]')
  expect(resolved.text).not.toContain('[kb:secret]')
  const none = await resolve({
    repo,
    task: 'review',
    notesChars: 0,
    neighbours: { repos: [{ repo: square, similarity: 0.7 }] },
  })
  expect(none.text).not.toContain('kb:')
})
