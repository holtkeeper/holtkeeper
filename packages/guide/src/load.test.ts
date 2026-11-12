import { expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { createGuideResolver } from './load.ts'

test('createGuideResolver reads family, sections, policies and notes from the store', async () => {
  const store = memoryStore()
  const at = '2026-11-01T10:00:00.000Z'
  await store.families.put({
    id: 'f1',
    name: 'Widgets',
    members: ['work:games/a'],
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
  await put('group:games', 'Team rule.')
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
  const repo = { forge: 'work', path: 'games/a', groups: ['games'] }

  const review = await resolve({ repo, task: 'review' })
  expect(review.text).toContain('Family rule.')
  expect(review.text).toContain('Team rule.')
  expect(review.text).not.toContain('72 characters')
  expect(review.text).not.toContain('[kb:k1]')

  const notes = await resolve({ repo, task: 'release-notes' })
  expect(notes.text).toContain('72 characters')
  expect(notes.text).toContain('[kb:k1]')
  expect((await resolve({ repo, task: 'release-notes', notesChars: 0 })).text).not.toContain(
    '[kb:k1]',
  )
})

test('a repository with no tests by design reads no testing sections', async () => {
  const store = memoryStore()
  const at = '2026-11-01T10:00:00.000Z'
  for (const section of ['general', 'testing'] as const)
    await store.guides.put({
      scope: 'group:games',
      section,
      rules: `${section} rule.`,
      steering: '',
      editedBy: 'jane',
      editedAt: at,
      learnings: [],
    })
  const resolve = createGuideResolver({ store })
  const repo = { forge: 'work', path: 'games/a', groups: ['games'] }
  expect((await resolve({ repo, task: 'review' })).text).toContain('testing rule.')

  await store.settings.put({
    id: 's1',
    key: 'repo.tests',
    scope: { groups: ['games'] },
    value: { expected: false },
    secret: false,
    updatedAt: at,
  })
  const review = await resolve({ repo, task: 'review' })
  expect(review.text).toContain('general rule.')
  expect(review.text).not.toContain('testing rule.')
  expect(review.text).toContain('This repository has no tests by design: do not add test files')
})
