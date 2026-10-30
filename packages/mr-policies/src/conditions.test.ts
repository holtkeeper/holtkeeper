import { describe, expect, test } from 'bun:test'

import { diffFile, fakeForge, mrEvent, pipeline } from '../test/fake-forge.ts'
import { changedLines, compileRegex, evaluateCondition } from './conditions.ts'
import { createFacts } from './facts.ts'
import type { Condition, MergeRequestEvent } from './model.ts'
import { conditionSchema } from './schema.ts'

function setup(event: MergeRequestEvent, forgeOptions: Parameters<typeof fakeForge>[0] = {}) {
  const fake = fakeForge(forgeOptions)
  const check = (when: Condition, bots?: string[]) =>
    evaluateCondition(when, { event, facts: createFacts(fake.forge, event), bots })
  return { ...fake, check }
}

describe('evaluateCondition', () => {
  test('an empty condition holds', async () => {
    expect((await setup(mrEvent()).check({})).ok).toBe(true)
  })

  test('matches events and branch globs', async () => {
    const { check } = setup(mrEvent({ mr: { sourceBranch: 'release/1.2', targetBranch: 'main' } }))
    const result = await check({
      event: ['open'],
      sourceBranch: ['release/*'],
      targetBranch: ['main'],
    })
    expect(result).toEqual({
      ok: true,
      reasons: [
        'event is open',
        'source branch release/1.2 matches release/*',
        'target branch main matches main',
      ],
    })
    expect((await check({ sourceBranch: ['hotfix/*'] })).reasons).toEqual([
      'source branch release/1.2 does not match hotfix/*',
    ])
    expect((await check({ event: ['merge'] })).ok).toBe(false)
  })

  test('matches authors by name, glob and bot flag', async () => {
    const event = mrEvent({ mr: { author: 'renovate-bot' } })
    const { check } = setup(event)
    expect((await check({ author: { users: ['renovate*'] } })).ok).toBe(true)
    expect((await check({ author: { users: ['alice'] } })).ok).toBe(false)
    expect((await check({ author: { bot: true } }, ['*-bot'])).ok).toBe(true)
    expect((await check({ author: { bot: true } })).ok).toBe(false)
    const flagged = setup({ ...event, authorIsBot: true })
    expect((await flagged.check({ author: { bot: true } })).ok).toBe(true)
  })

  test('checks labels, added labels, title regex, draft and commands', async () => {
    const event = mrEvent({
      action: 'command',
      command: 'approve',
      labelsAdded: ['automerge'],
      mr: { labels: ['deps', 'patch'], title: 'chore(deps): update x to v1.2.3', draft: false },
    })
    const { check } = setup(event)
    expect(
      (await check({ labels: { all: ['deps', 'patch'], any: ['x', 'patch'], none: ['wip'] } })).ok,
    ).toBe(true)
    expect((await check({ labels: { all: ['deps', 'major'] } })).reasons).toEqual([
      'missing labels major',
    ])
    expect((await check({ labels: { none: ['patch'] } })).ok).toBe(false)
    expect((await check({ labelAdded: ['automerge'] })).ok).toBe(true)
    expect((await check({ labelAdded: ['other'] })).ok).toBe(false)
    expect((await check({ title: '^chore\\(deps\\)' })).ok).toBe(true)
    expect((await check({ title: '/^CHORE/i' })).ok).toBe(true)
    expect((await check({ title: '/^CHORE/' })).ok).toBe(false)
    expect((await check({ draft: false })).ok).toBe(true)
    expect((await check({ draft: true })).ok).toBe(false)
    expect((await check({ command: ['approve'] })).ok).toBe(true)
    expect((await check({ command: ['merge'] })).ok).toBe(false)
  })

  test('combines with all, any and not', async () => {
    const { check } = setup(mrEvent({ mr: { targetBranch: 'develop' } }))
    expect(
      (await check({ any: [{ targetBranch: ['main'] }, { targetBranch: ['develop'] }] })).ok,
    ).toBe(true)
    expect((await check({ all: [{ targetBranch: ['develop'] }, { draft: true }] })).ok).toBe(false)
    expect((await check({ not: { targetBranch: ['main'] } })).ok).toBe(true)
    expect((await check({ not: { any: [{ draft: false }] } })).ok).toBe(false)
    const none = await check({ any: [{ targetBranch: ['main'] }, { draft: true }] })
    expect(none.reasons[0]).toStartWith('none of:')
  })

  test('changed paths with all, any and none', async () => {
    const files = [
      diffFile('docs/a.md'),
      diffFile('README.md'),
      diffFile('old.ts', 1, { status: 'deleted', newPath: '' }),
    ]
    const { check } = setup(mrEvent(), { files })
    expect((await check({ changedPaths: { all: ['**/*.md', '*.ts'] } })).ok).toBe(true)
    expect((await check({ changedPaths: { all: ['**/*.md'] } })).reasons).toEqual([
      'changed path old.ts does not match **/*.md',
    ])
    expect((await check({ changedPaths: { any: ['docs/**'] } })).ok).toBe(true)
    expect((await check({ changedPaths: { none: ['src/**'] } })).ok).toBe(true)
    expect((await check({ changedPaths: { none: ['*.ts'] } })).ok).toBe(false)
    expect((await check({ changedPaths: { all: ['**/{package-lock.json,bun.lock}'] } })).ok).toBe(
      false,
    )
  })

  test('lockfile globs match at the root and nested', async () => {
    const files = [diffFile('bun.lock'), diffFile('web/package-lock.json')]
    const { check } = setup(mrEvent(), { files })
    expect((await check({ changedPaths: { all: ['**/{package-lock.json,bun.lock}'] } })).ok).toBe(
      true,
    )
  })

  test('size limits count lines and files; collapsed files exceed line limits', async () => {
    const { check } = setup(mrEvent(), { files: [diffFile('a.ts', 30), diffFile('b.ts', 20)] })
    expect((await check({ size: { maxLines: 50, maxFiles: 2 } })).ok).toBe(true)
    expect((await check({ size: { maxLines: 49 } })).reasons).toEqual(['50 lines > 49'])
    expect((await check({ size: { maxFiles: 1 } })).ok).toBe(false)
    expect((await check({ size: { minLines: 51 } })).ok).toBe(false)
    const collapsed = setup(mrEvent(), {
      files: [diffFile('big.json', 0, { collapsed: true, diff: '' })],
    })
    expect((await collapsed.check({ size: { maxLines: 10_000 } })).ok).toBe(false)
  })

  test('pipeline state of the latest pipeline for the head commit', async () => {
    const pipelines = [
      pipeline('failed', 1),
      pipeline('success', 2),
      pipeline('running', 3, 'other'),
    ]
    const { check } = setup(mrEvent({ mr: { headSha: 'sha1' } }), { pipelines })
    expect((await check({ pipeline: ['success'] })).ok).toBe(true)
    expect((await check({ pipeline: ['failed'] })).reasons).toEqual([
      'pipeline is success, not failed',
    ])
    const none = setup(mrEvent(), { pipelines: [] })
    expect((await none.check({ pipeline: ['none'] })).ok).toBe(true)
  })

  test('loads the diff only when a path condition is reached, and only once', async () => {
    const { check, counts } = setup(mrEvent({ mr: { targetBranch: 'develop' } }), {
      files: [diffFile('a.md')],
    })
    await check({ targetBranch: ['main'], changedPaths: { all: ['**/*.md'] } })
    expect(counts.diff).toBe(0)
    await check({ targetBranch: ['develop'] })
    expect(counts.diff).toBe(0)
    const shared = setup(mrEvent(), { files: [diffFile('a.md')] })
    const facts = createFacts(shared.forge, mrEvent())
    const context = { event: mrEvent(), facts }
    await evaluateCondition({ changedPaths: { all: ['**/*.md'] }, size: { maxLines: 10 } }, context)
    await evaluateCondition({ changedPaths: { any: ['**/*.md'] } }, context)
    expect(shared.counts.diff).toBe(1)
  })

  test('fails path conditions when the forge cannot load diffs', async () => {
    const { check } = setup(mrEvent(), { minimal: true })
    expect((await check({ changedPaths: { any: ['**'] } })).reasons).toEqual([
      'the forge cannot load merge request diffs',
    ])
  })
})

describe('helpers', () => {
  test('changedLines ignores file headers', () => {
    expect(changedLines('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c')).toBe(2)
  })

  test('compileRegex accepts slash literals', () => {
    expect(compileRegex('/a.b/i').flags).toBe('i')
    expect(compileRegex('a/b').source).toBe('a\\/b')
  })
})

describe('conditionSchema', () => {
  test('normalizes single values to lists', () => {
    expect(
      conditionSchema.parse({
        event: 'open',
        targetBranch: 'main',
        author: 'renovate-bot',
        pipeline: 'success',
      }),
    ).toEqual({
      event: ['open'],
      targetBranch: ['main'],
      author: { users: ['renovate-bot'] },
      pipeline: ['success'],
    })
  })

  test('rejects unknown fields and bad regexes', () => {
    expect(conditionSchema.safeParse({ branch: 'main' }).success).toBe(false)
    expect(conditionSchema.safeParse({ title: '(' }).success).toBe(false)
    expect(conditionSchema.safeParse({ not: { any: [{ draft: 'yes' }] } }).success).toBe(false)
  })
})
