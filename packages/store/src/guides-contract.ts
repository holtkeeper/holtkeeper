import { expect, test } from 'bun:test'

import { FamilyConflictError } from './guides.ts'
import type { Family, GuideSection, GuideSectionInput, Store } from './types.ts'

const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`

const section = (overrides: Partial<GuideSectionInput> = {}): GuideSectionInput => ({
  scope: 'group:games',
  section: 'general',
  rules: 'Keep components small.',
  steering: '',
  editedBy: 'jane',
  editedAt: at(0),
  learnings: [],
  ...overrides,
})

const family = (id: string, members: string[], overrides: Partial<Family> = {}): Family => ({
  id,
  name: `Family ${id}`,
  members,
  createdBy: 'jane',
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

const layer = (body: string, status: 'proposed' | 'accepted') => ({
  body,
  inputHash: body,
  model: 'model-main',
  costUsd: 0.02,
  status,
  generatedAt: at(1),
  prompt: 'Mention the widget folder.',
  ...(status === 'accepted' && { acceptedBy: 'jane', acceptedAt: at(2) }),
})

/** Guide and family tests of the store contract; `store` gives the store of the current test. */
export function guideStoreTests(store: () => Store) {
  test('guides: human edits bump the version and keep history, other writes do not', async () => {
    const guides = store().guides
    const first = await guides.put(section())
    expect(first).toMatchObject({ version: 1, editedBy: 'jane', editedAt: at(0) })
    expect(await guides.history('group:games', 'general')).toEqual([])

    const generated = {
      body: '- Run `bun test`.',
      inputHash: 'h1',
      model: 'model-fast',
      costUsd: 0.01,
      status: 'proposed' as const,
      generatedAt: at(1),
      sha: 'abc123',
    }
    const withGenerated = await guides.put(
      section({ generated, editedBy: 'agent:guide', editedAt: at(1) }),
    )
    expect(withGenerated).toMatchObject({ version: 1, editedBy: 'jane', editedAt: at(0) })
    expect(withGenerated.generated).toEqual({ ...generated, version: 1 })

    const learnings = [
      {
        id: 'l1',
        rule: 'Never put ids on layout wrappers.',
        sources: [{ label: 'MR !4', url: 'https://forge.test/mr/4' }],
        acceptedBy: 'bob',
        acceptedAt: at(2),
      },
    ]
    await guides.put(section({ generated, learnings, editedBy: 'bob', editedAt: at(2) }))
    const edited = await guides.put(
      section({
        rules: 'Keep files short.',
        generated,
        learnings,
        editedBy: 'bob',
        editedAt: at(3),
      }),
    )
    expect(edited).toEqual({
      scope: 'group:games',
      section: 'general',
      rules: 'Keep files short.',
      steering: '',
      version: 2,
      editedBy: 'bob',
      editedAt: at(3),
      generated: { ...generated, version: 1 },
      learnings,
    })
    await guides.put(
      section({ rules: 'Keep files short.', steering: 'Ignore legacy/.', editedAt: at(4) }),
    )
    expect(await guides.get('group:games', 'general')).toMatchObject({ version: 3 })
    expect(await guides.history('group:games', 'general')).toEqual([
      { rules: 'Keep files short.', steering: '', version: 2, editedBy: 'bob', editedAt: at(3) },
      {
        rules: 'Keep components small.',
        steering: '',
        version: 1,
        editedBy: 'jane',
        editedAt: at(0),
      },
    ])
  })

  test('guides: a proposal is kept next to accepted text and dropped when left out', async () => {
    const guides = store().guides
    const generated = layer('- Run `make test`.', 'accepted')
    const proposal = layer('- Run `make check`.', 'proposed')
    const stored = await guides.put(section({ generated, proposal }))
    expect(stored.proposal).toEqual({ ...proposal, version: 2 })
    expect((await guides.get('group:games', 'general'))?.generated).toEqual({
      ...generated,
      version: 1,
    })
    await guides.put(section({ generated }))
    expect((await guides.get('group:games', 'general'))?.proposal).toBeUndefined()
  })

  test('guides: generator runs get versions and a history, newest first', async () => {
    const guides = store().guides
    const scope = 'repo:gl:acme/widget-kit'
    expect(await guides.generatedHistory(scope, 'testing')).toEqual([])
    const first = { ...layer('- Run `bun test`.', 'proposed'), jobId: 'job-1' }
    const one = await guides.put(section({ scope, section: 'testing', generated: first }))
    expect(one.generated).toEqual({ ...first, version: 1 })

    const accepted = {
      ...first,
      status: 'accepted' as const,
      acceptedBy: 'jane',
      acceptedAt: at(3),
    }
    const acceptedRow = await guides.put(
      section({ scope, section: 'testing', generated: accepted }),
    )
    expect(acceptedRow.generated?.version).toBe(1)

    const second = {
      ...layer('- Run `bun test --coverage`.', 'proposed'),
      generatedAt: at(4),
      jobId: 'job-2',
    }
    const two = await guides.put(
      section({ scope, section: 'testing', generated: accepted, proposal: second }),
    )
    expect(two.generated?.version).toBe(1)
    expect(two.proposal).toEqual({ ...second, version: 2 })

    const kept = await guides.put(
      section({
        scope,
        section: 'testing',
        generated: { ...accepted, inputHash: 'fresh-hash', version: 7 },
        proposal: { ...second, version: 2 },
      }),
    )
    expect(kept.generated).toMatchObject({ version: 1, inputHash: 'fresh-hash' })
    expect(kept.proposal?.version).toBe(2)

    const third = { ...layer('- Run `bun test` first.', 'proposed'), generatedAt: at(6) }
    const three = await guides.put(
      section({ scope, section: 'testing', generated: accepted, proposal: third }),
    )
    expect(three.proposal?.version).toBe(3)
    await guides.put(section({ scope, section: 'testing', generated: accepted }))

    expect(await guides.generatedHistory(scope, 'testing')).toEqual([
      { ...third, version: 3 },
      { ...second, version: 2 },
      { ...accepted, version: 1 },
    ])
    expect(await guides.generatedHistory(scope, 'general')).toEqual([])
    expect(await guides.generatedHistory('all', 'testing')).toEqual([])

    const human = await guides.put(
      section({ scope, section: 'testing', rules: 'New rules.', generated: accepted }),
    )
    expect(human.generated?.version).toBe(1)
    expect(await guides.generatedHistory(scope, 'testing')).toHaveLength(3)
  })

  test('guides: an empty first write has version 0 and no byline', async () => {
    const guides = store().guides
    const empty = section({ rules: '', scope: 'repo:work:games/a' })
    delete empty.editedBy
    delete empty.editedAt
    const stored = await guides.put(empty)
    const expected: GuideSection = {
      scope: empty.scope,
      section: empty.section,
      rules: empty.rules,
      steering: empty.steering,
      learnings: empty.learnings,
      version: 0,
    }
    expect(stored).toEqual(expected)
    expect(await guides.get('repo:work:games/a', 'general')).toEqual(expected)
    await guides.put({ ...empty, rules: 'First rule.', editedBy: 'jane', editedAt: at(5) })
    expect(await guides.history('repo:work:games/a', 'general')).toEqual([])
  })

  test('guides: list filters and sorts, removeScope drops sections and history', async () => {
    const guides = store().guides
    await guides.put(section({ scope: 'repo:work:games/a', section: 'testing' }))
    await guides.put(section({ scope: 'all', section: 'review' }))
    await guides.put(section({ scope: 'repo:work:games/a', section: 'general' }))
    await guides.put(section({ scope: 'family:f1' }))
    await guides.put(section({ scope: 'family:f1', rules: 'Changed.' }))
    const keys = async (filter?: Parameters<typeof guides.list>[0]) =>
      (await guides.list(filter)).map((row) => `${row.scope}/${row.section}`)
    expect(await keys()).toEqual([
      'all/review',
      'family:f1/general',
      'repo:work:games/a/general',
      'repo:work:games/a/testing',
    ])
    expect(await keys({ scopes: ['all', 'family:f1'] })).toEqual([
      'all/review',
      'family:f1/general',
    ])
    expect(await keys({ sections: ['general'] })).toEqual([
      'family:f1/general',
      'repo:work:games/a/general',
    ])
    expect(await keys({ scopes: [] })).toEqual([])

    await guides.put(
      section({ scope: 'family:f1', rules: 'Changed.', generated: layer('- Text.', 'proposed') }),
    )
    expect(await guides.generatedHistory('family:f1', 'general')).toHaveLength(1)
    await guides.removeScope('family:f1')
    expect(await guides.get('family:f1', 'general')).toBeUndefined()
    expect(await guides.history('family:f1', 'general')).toEqual([])
    expect(await guides.generatedHistory('family:f1', 'general')).toEqual([])
    await guides.put(section({ scope: 'family:f1', generated: layer('- Text.', 'proposed') }))
    expect((await guides.get('family:f1', 'general'))?.generated?.version).toBe(1)
    await guides.removeScope('family:f1')
    expect(await keys()).toHaveLength(3)
  })

  test('families: put, list by name, conflicts leave the store unchanged, remove', async () => {
    const families = store().families
    await families.put(family('f2', ['work:shop/b', 'work:shop/a'], { name: 'Shops' }))
    await families.put(family('f1', ['work:games/a', 'work:games/b'], { name: 'Games' }))
    expect((await families.list()).map((f) => f.name)).toEqual(['Games', 'Shops'])
    expect((await families.get('f2'))?.members).toEqual(['work:shop/a', 'work:shop/b'])

    const conflict = families.put(family('f3', ['work:games/b', 'work:tools/x']))
    expect(conflict).rejects.toBeInstanceOf(FamilyConflictError)
    await conflict.catch(() => undefined)
    expect(await families.get('f3')).toBeUndefined()

    const renamed = family('f1', ['work:games/a'], {
      name: 'Game apps',
      updatedAt: at(9),
      updatedBy: 'bob',
    })
    await families.put(renamed)
    expect(await families.get('f1')).toEqual(renamed)
    await families.put(family('f3', ['work:games/b']))
    await families.remove('f1')
    expect((await families.list()).map((f) => f.id)).toEqual(['f3', 'f2'])
  })
}
