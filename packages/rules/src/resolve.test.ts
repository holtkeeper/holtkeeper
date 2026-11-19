import { describe, expect, test } from 'bun:test'

import type { Learning, Rule } from '@holtkeeper/store'

import { newLearning } from './learnings.ts'
import type { RepoRuleFile } from './repo-files.ts'
import { LEARNED_HEADER, RULES_HEADER, resolveRules } from './resolve.ts'

const repo = { forge: 'work', path: 'acme/round/web', teams: ['widgets'] }
const now = '2026-01-10T00:00:00.000Z'

const rule = (id: string, extra: Partial<Rule> = {}): Rule => ({
  id,
  title: `Rule ${id}`,
  body: `- Body of ${id}.`,
  scope: { all: true },
  author: 'mira',
  createdAt: now,
  updatedAt: now,
  version: 1,
  ...extra,
})

const learning = (id: string, text: string, extra: Partial<Learning> = {}): Learning => ({
  ...newLearning(
    { text, scope: { repos: ['work:acme/round/web'] }, origin: 'reply' },
    { id, now, policy: { approvalDelayDays: 0, expiryDays: 90 } },
  ),
  ...extra,
})

const file = (path: string, extra: Partial<RepoRuleFile> = {}): RepoRuleFile => ({
  path,
  text: `- From ${path}.`,
  kind: 'always',
  globs: [],
  ...extra,
})

describe('resolveRules', () => {
  test('orders organization, team, repository files, file rules, policies, learnings', () => {
    const resolved = resolveRules({
      repo,
      agent: 'review',
      files: ['src/forms/shape.ts'],
      rules: [
        rule('t', { scope: { teams: ['widgets'] } }),
        rule('o'),
        rule('f', { files: ['src/forms/**'] }),
        rule('other', { scope: { teams: ['gizmos'] } }),
        rule('miss', { files: ['docs/**'] }),
        rule('chat', { agents: ['chat'] }),
      ],
      repoFiles: [
        file('AGENTS.md'),
        file('src/forms/AGENTS.md', { kind: 'files', globs: ['src/forms/**'] }),
      ],
      learnings: [learning('l1', 'Prefer integer cents for prices.')],
      policies: [{ title: 'Assets', text: '- Images are at most 2048 px.' }],
      teamTitle: (key) => key.toUpperCase(),
    })
    expect(resolved.blocks.map((block) => block.id)).toEqual([
      'o',
      't',
      'AGENTS.md',
      'f',
      'src/forms/AGENTS.md',
      'policy:Assets',
      'learnings',
    ])
    expect(resolved.blocks[1]?.source).toBe('Team WIDGETS')
    expect(resolved.text.startsWith(RULES_HEADER)).toBe(true)
    expect(resolved.text).toContain('### Rule o [rule:o]\n- Body of o.')
    expect(resolved.text).toContain(
      `${LEARNED_HEADER}\n- Prefer integer cents for prices. [learn:l1]`,
    )
    expect(resolved.warnings).toEqual([])
  })

  test('without files, file-scoped rules come with the paths they apply to', () => {
    const resolved = resolveRules({
      repo,
      agent: 'task',
      rules: [rule('f', { files: ['src/**'] })],
      repoFiles: [],
      learnings: [],
    })
    expect(resolved.text).toContain('### Rule f [rule:f] (applies to `src/**`)')
  })

  test('description-only rules are offered, not injected', () => {
    const resolved = resolveRules({
      repo,
      agent: 'task',
      rules: [rule('d', { description: 'When touching shape math' })],
      repoFiles: [file('.cursor/rules/x.mdc', { kind: 'requested', description: 'Forms' })],
      learnings: [],
    })
    expect(resolved.text).toBe('')
    expect(resolved.requested.map((item) => item.id)).toEqual(['d', '.cursor/rules/x.mdc'])
  })

  test('repository files share their cap and point at the file when cut', () => {
    const resolved = resolveRules({
      repo,
      agent: 'review',
      rules: [],
      repoFiles: [file('AGENTS.md', { text: 'line\n'.repeat(400) })],
      learnings: [],
      budget: { repoFiles: 500 },
    })
    const block = resolved.blocks[0]
    expect(block?.cut).toBe(true)
    expect(block?.chars).toBeLessThanOrEqual(500)
    expect(block?.text.endsWith('[… truncated, see AGENTS.md]')).toBe(true)
    expect(resolved.warnings).toHaveLength(1)
  })

  test('learnings are ranked and dropped whole when out of room', () => {
    const resolved = resolveRules({
      repo,
      agent: 'review',
      rules: [],
      repoFiles: [],
      learnings: [
        learning('weak', 'Weak rule about widgets.'),
        learning('strong', 'Strong rule about shapes.', { actedOn: 4 }),
        learning('pending', 'Pending rule.', { status: 'pending' }),
        learning('elsewhere', 'Other repository rule.', { scope: { repos: ['work:acme/other'] } }),
      ],
      budget: { learnings: LEARNED_HEADER.length + 45 },
    })
    const block = resolved.blocks.at(-1)
    expect(block?.text).toBe(`${LEARNED_HEADER}\n- Strong rule about shapes. [learn:strong]`)
    expect(block?.cut).toBe(true)
    expect(block?.source).toBe('1 of 2 learned rules')
  })

  test('with files, learned rules about them come first', () => {
    const resolved = resolveRules({
      repo,
      agent: 'task',
      rules: [],
      repoFiles: [],
      files: ['src/features/widgetPanel/WidgetPanel.tsx', 'src/assets/banner.png'],
      learnings: [
        learning('used', 'Keep round handlers small.', { actedOn: 4 }),
        learning('asset', 'Ship a webp next to every image.'),
        learning('panel', 'A widget panel takes its store through props.'),
      ],
      budget: { learnings: LEARNED_HEADER.length + 125 },
    })
    const block = resolved.blocks.at(-1)
    expect(block?.text).toBe(
      `${LEARNED_HEADER}\n- A widget panel takes its store through props. [learn:panel]\n- Ship a webp next to every image. [learn:asset]`,
    )
    expect(resolved.warnings.at(-1)).toContain('those least about the files touched first')
  })

  test('input order does not change the text', () => {
    const rules = [rule('a'), rule('b', { scope: { teams: ['widgets'] } }), rule('c')]
    const one = resolveRules({ repo, agent: 'review', rules, repoFiles: [], learnings: [] })
    const two = resolveRules({
      repo,
      agent: 'review',
      rules: rules.toReversed(),
      repoFiles: [],
      learnings: [],
    })
    expect(two.text).toBe(one.text)
  })
})
