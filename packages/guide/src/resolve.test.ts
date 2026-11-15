import { describe, expect, test } from 'bun:test'

import type { GuideSection, KnowledgeEntry } from '@holtkeeper/store'

import {
  GENERATED_HEADER,
  GUIDE_CAPS,
  type ResolveGuideInput,
  cutText,
  resolveGuide,
} from './resolve.ts'

const repo = { forge: 'work', path: 'acme/round/web', teams: ['widgets', 'gizmo'] }

const row = (overrides: Partial<GuideSection>): GuideSection => ({
  scope: 'all',
  section: 'general',
  rules: '',
  steering: '',
  version: 1,
  learnings: [],
  ...overrides,
})

const note = (id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id,
  title: `Note ${id}`,
  body: 'Use the shared widget registry.',
  kind: 'convention',
  scope: { all: true },
  topics: [],
  appliesTo: ['*'],
  status: 'accepted',
  evidence: [],
  source: 'human',
  author: 'jane',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  version: 1,
  ...overrides,
})

const input = (overrides: Partial<ResolveGuideInput> = {}): ResolveGuideInput => ({
  repo,
  task: 'review',
  sections: [],
  ...overrides,
})

const positions = (text: string, needles: string[]) => needles.map((needle) => text.indexOf(needle))

const ruleLines = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `- ${prefix} rule ${i}: keep widgets small.`).join('\n')

describe('resolveGuide', () => {
  test('orders layers by precedence and keeps rows of other scopes out', () => {
    const resolved = resolveGuide(
      input({
        family: { id: 'f1', name: 'Widget apps' },
        repoDocs: [{ file: 'AGENTS.md', text: 'Run bun test before pushing.' }],
        policies: [{ section: 'commits', text: '- Commit titles have at most 72 characters.' }],
        task: 'chat',
        section: 'commits',
        sections: [
          row({ scope: 'all', rules: 'ALL rule.' }),
          row({ scope: 'team:gizmo', rules: 'GIZMO rule.' }),
          row({ scope: 'team:widgets', rules: 'WIDGETS rule.' }),
          row({ scope: 'path:work:acme', rules: 'ACME rule.' }),
          row({ scope: 'path:work:acme/round', rules: 'ROUND rule.' }),
          row({ scope: 'family:f1', rules: 'FAMILY rule.' }),
          row({ scope: 'repo:work:acme/round/other', rules: 'OTHER rule.' }),
          row({ scope: 'team:sprockets', rules: 'SPROCKETS rule.' }),
          row({ scope: 'path:work:acme/square', rules: 'SQUARE rule.' }),
          row({ scope: 'path:other:acme', rules: 'OTHER FORGE rule.' }),
          row({
            scope: 'team:widgets',
            section: 'commits',
            rules: 'WIDGETS commit rule.',
            learnings: [
              {
                id: 'l1',
                rule: 'Squash fixup commits.',
                sources: [],
                acceptedBy: 'bob',
                acceptedAt: '2026-11-01T10:00:00.000Z',
              },
            ],
          }),
          row({
            scope: 'repo:work:acme/round/web',
            rules: 'REPO rule.',
            generated: {
              version: 1,
              body: '- GENERATED line.',
              inputHash: 'h',
              model: 'm',
              costUsd: 0,
              status: 'accepted',
              generatedAt: '2026-11-01T10:00:00.000Z',
            },
          }),
        ],
        notes: { entries: [note('n1')], kind: 'chat' },
      }),
    )
    expect(resolved.sections).toEqual(['general', 'commits'])
    expect(resolved.text).not.toContain('OTHER')
    expect(resolved.text).not.toContain('SPROCKETS')
    expect(resolved.text).not.toContain('SQUARE')
    expect(resolved.text).not.toContain('OTHER FORGE')
    const order = positions(resolved.text, [
      'AGENTS.md',
      'REPO rule',
      'FAMILY rule',
      'ROUND rule',
      'ACME rule',
      'WIDGETS rule',
      'WIDGETS commit rule',
      'GIZMO rule',
      'ALL rule',
      'Squash fixup commits',
      '72 characters',
      GENERATED_HEADER,
      'GENERATED line',
      '[kb:n1]',
    ])
    expect(order.every((at) => at >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    expect(resolved.text).toContain('## Team rules for the Widget apps family')
    expect(resolved.text).toContain('## Rules for folder acme/round\n')
    expect(resolved.text).toContain('## Team rules for team widgets\n')
    expect(resolved.warnings).toEqual([])
    expect(resolved.budget.used).toBe(resolved.text.length)
  })

  test('is deterministic whatever order the rows come in', () => {
    const sections = [
      row({ scope: 'all', rules: 'A.' }),
      row({ scope: 'team:widgets', section: 'testing', rules: 'B.' }),
      row({ scope: 'path:work:acme', rules: 'E.' }),
      row({ scope: 'repo:work:acme/round/web', section: 'review', rules: 'C.' }),
      row({ scope: 'team:gizmo', rules: 'D.' }),
    ]
    const notes = { entries: [note('n1'), note('n2')], kind: 'review' }
    const first = resolveGuide(input({ sections, notes }))
    const second = resolveGuide(input({ sections: sections.toReversed(), notes }))
    expect(second.text).toBe(first.text)
    expect(second.blocks).toEqual(first.blocks)
  })

  test('returns nothing when nothing applies', () => {
    const resolved = resolveGuide(input())
    expect(resolved.text).toBe('')
    expect(resolved.budget.used).toBe(0)
  })

  test('selects sections per task', () => {
    const sections = [
      'general',
      'review',
      'testing',
      'testids',
      'assets',
      'commits',
      'releases',
    ].map((section) =>
      row({ section: section as GuideSection['section'], rules: `${section} rule.` }),
    )
    const rulesIn = (text: string) =>
      sections.map((s) => s.section).filter((section) => text.includes(`${section} rule.`))
    expect(rulesIn(resolveGuide(input({ sections })).text)).toEqual([
      'general',
      'review',
      'testing',
      'testids',
      'assets',
    ])
    expect(rulesIn(resolveGuide(input({ sections, task: 'release-notes' })).text)).toEqual([
      'commits',
      'releases',
    ])
    expect(
      rulesIn(resolveGuide(input({ sections, task: 'chat', section: 'testing' })).text),
    ).toEqual(['general', 'testing'])
    expect(rulesIn(resolveGuide(input({ sections, task: 'agent' })).text)).toEqual(['general'])
  })

  test('proposed generated text only reaches tasks when no human rules or repo docs exist', () => {
    const generated = row({
      scope: 'repo:work:acme/round/web',
      generated: {
        version: 1,
        body: '- Proposed line.',
        inputHash: 'h',
        model: 'm',
        costUsd: 0,
        status: 'proposed',
        generatedAt: '2026-11-01T10:00:00.000Z',
      },
    })
    const alone = resolveGuide(input({ sections: [generated] }))
    expect(alone.text).toContain('Proposed line')
    expect(alone.blocks).toContainEqual(expect.objectContaining({ proposed: true }))
    expect(
      resolveGuide(input({ sections: [generated, row({ scope: 'all', rules: 'Rule.' })] })).text,
    ).not.toContain('Proposed line')
    expect(
      resolveGuide(input({ sections: [generated], repoDocs: [{ file: 'CLAUDE.md', text: 'x' }] }))
        .text,
    ).not.toContain('Proposed line')
  })

  test('over the human budget cuts all first, then teams, never the repository', () => {
    const resolved = resolveGuide(
      input({
        caps: { total: 3000, human: 2000, generated: 600 },
        sections: [
          row({ scope: 'repo:work:acme/round/web', rules: 'R'.repeat(900) }),
          row({ scope: 'team:widgets', rules: `${'G'.repeat(400)}\n${'g'.repeat(700)}` }),
          row({ scope: 'all', rules: 'A'.repeat(800) }),
          row({
            scope: 'repo:work:acme/round/web',
            section: 'testing',
            generated: {
              version: 2,
              body: Array.from({ length: 40 }, (_, i) => `- generated line ${i}`).join('\n'),
              inputHash: 'h',
              model: 'm',
              costUsd: 0,
              status: 'accepted',
              generatedAt: '2026-11-01T10:00:00.000Z',
            },
          }),
        ],
        notes: { entries: [note('n1', { body: 'N'.repeat(2000) })], kind: 'review' },
      }),
    )
    expect(resolved.text).toContain('R'.repeat(900))
    expect(resolved.text).toContain('G'.repeat(400))
    expect(resolved.text).not.toContain('A'.repeat(100))
    expect(resolved.text).not.toContain('[kb:n1]')
    expect(resolved.text.length).toBeLessThanOrEqual(3000)
    expect(resolved.budget.humanUsed).toBeLessThanOrEqual(2000)
    expect(resolved.budget.generatedUsed).toBeLessThanOrEqual(600)
    const layers = Object.fromEntries(resolved.blocks.map((b) => [b.layer, b]))
    expect(layers.repo).toMatchObject({ cut: false })
    expect(layers.all).toMatchObject({ chars: 0, cut: true })
    expect(layers.generated).toMatchObject({ cut: true })
    expect(layers.notes).toMatchObject({ chars: 0, cut: true })
    expect(layers.team).toMatchObject({ cut: true })
    expect(resolved.warnings).toEqual([
      expect.stringMatching(
        /^Team rules for team widgets were cut to fit the budget \(\d+ of \d+ characters\)\.$/,
      ),
      'Team rules for all repositories were left out: the budget for human rules is used up.',
    ])
  })

  test('repository rules over the human budget stay whole with a warning', () => {
    const resolved = resolveGuide(
      input({
        caps: { total: 4000, human: 1000, generated: 500 },
        sections: [
          row({ scope: 'repo:work:acme/round/web', rules: 'R'.repeat(1100) }),
          row({ scope: 'team:widgets', rules: 'G'.repeat(300) }),
        ],
      }),
    )
    expect(resolved.text).toContain('R'.repeat(1100))
    expect(resolved.text).not.toContain('G'.repeat(300))
    expect(resolved.warnings[0]).toStartWith('Repository rules take')
    expect(resolved.warnings[0]).toContain('over the 1000-character budget')
  })

  test('a huge rules file is capped and cut with a pointer, so every team and learned rule fits', () => {
    const resolved = resolveGuide(
      input({
        repoDocs: [
          {
            file: 'CONTRIBUTING.md',
            text: Array.from({ length: 400 }, (_, i) => `Line ${i} about shapes.`).join('\n'),
          },
          { file: 'AGENTS.md', text: 'Run bun test before pushing.' },
        ],
        sections: [
          row({ scope: 'repo:work:acme/round/web', rules: ruleLines('repo', 5) }),
          row({ scope: 'team:widgets', rules: ruleLines('team', 15) }),
          row({ scope: 'all', rules: ruleLines('fleet', 5) }),
          row({
            scope: 'team:widgets',
            section: 'review',
            learnings: Array.from({ length: 10 }, (_, i) => ({
              id: `l${i}`,
              rule: `Learned rule ${i}: prefer ShapeBase.`,
              sources: [],
              acceptedBy: 'someone',
              acceptedAt: '2026-11-01T10:00:00.000Z',
            })),
          }),
        ],
      }),
    )
    for (const rule of ['repo rule 4', 'team rule 14', 'fleet rule 4', 'Learned rule 9'])
      expect(resolved.text).toContain(rule)
    const files = resolved.blocks.find((block) => block.layer === 'repo-file')
    expect(files).toMatchObject({ cut: true })
    expect(files?.chars).toBeLessThanOrEqual(GUIDE_CAPS.repoFiles)
    expect(files?.text).toContain('[… truncated, see CONTRIBUTING.md]')
    expect(files?.text).toContain('### AGENTS.md\n\n[… truncated, see AGENTS.md]')
    expect(
      resolved.blocks.filter((block) => block.layer !== 'repo-file').every((b) => !b.cut),
    ).toBe(true)
    expect(resolved.warnings).toEqual([
      expect.stringMatching(
        /^Rules files \(CONTRIBUTING\.md · AGENTS\.md\) take \d+ characters; they may use 4800 of the 12000-character Guide/,
      ),
    ])
    expect(resolved.text.length).toBeLessThanOrEqual(GUIDE_CAPS.total)
  })

  test('large repository rules do not take the room kept for learned rules', () => {
    const resolved = resolveGuide(
      input({
        repoDocs: [{ file: 'AGENTS.md', text: 'line about widgets\n'.repeat(320) }],
        sections: [
          row({ scope: 'repo:work:acme/round/web', rules: 'R'.repeat(4000) }),
          row({
            scope: 'team:widgets',
            section: 'review',
            learnings: Array.from({ length: 10 }, (_, i) => ({
              id: `l${i}`,
              rule: `Learned rule ${i}: keep fooUtil pure and small.`,
              sources: [],
              acceptedBy: 'someone',
              acceptedAt: '2026-11-01T10:00:00.000Z',
            })),
          }),
        ],
      }),
    )
    expect(resolved.text).toContain('R'.repeat(4000))
    expect(resolved.text).toContain('Learned rule 9')
    expect(resolved.blocks.find((block) => block.layer === 'repo-file')).toMatchObject({
      cut: true,
    })
    expect(resolved.blocks.find((block) => block.layer === 'learnings')?.cut).toBeFalsy()
    expect(resolved.budget.humanUsed).toBeLessThanOrEqual(GUIDE_CAPS.human)
  })

  test('a file after one that nearly fills the room keeps its pointer', () => {
    const resolved = resolveGuide(
      input({
        repoDocs: [
          { file: 'AGENTS.md', text: 'A'.repeat(4700) },
          { file: 'CONTRIBUTING.md', text: 'C'.repeat(2000) },
        ],
      }),
    )
    const files = resolved.blocks.find((block) => block.layer === 'repo-file')
    expect(files?.text).toContain('[… truncated, see CONTRIBUTING.md]')
    expect(files?.chars).toBeLessThanOrEqual(GUIDE_CAPS.repoFiles)
  })

  test('rules files that fit stay whole next to the rules', () => {
    const resolved = resolveGuide(
      input({
        caps: { total: 3000, human: 2000, generated: 500 },
        repoDocs: [{ file: 'AGENTS.md', text: 'D'.repeat(1000) }],
        sections: [
          row({ scope: 'repo:work:acme/round/web', rules: 'R'.repeat(300) }),
          row({ scope: 'all', rules: 'A'.repeat(300) }),
        ],
      }),
    )
    expect(resolved.text).toContain('D'.repeat(1000))
    expect(resolved.text).toContain('R'.repeat(300))
    expect(resolved.text).toContain('A'.repeat(300))
    expect(resolved.blocks.some((block) => block.cut)).toBe(false)
    expect(resolved.warnings).toEqual([])
    expect(resolved.budget.humanUsed).toBeLessThanOrEqual(2000)
    expect(resolved.budget).toMatchObject({ repoFiles: 1200, rules: 1000 })
  })

  test('repository text over the total cap is cut with a warning', () => {
    const resolved = resolveGuide(
      input({
        caps: { total: 1500, human: 1000, generated: 500 },
        sections: [row({ scope: 'repo:work:acme/round/web', rules: 'line\n'.repeat(600) })],
      }),
    )
    expect(resolved.text.length).toBeLessThanOrEqual(1500)
    expect(resolved.text).toContain('[...]')
    expect(resolved.warnings[0]).toContain('their end was cut')
  })

  test('notes see the family and the touched files of the task', () => {
    const entries = [
      note('fam', { match: { families: ['f1'] } }),
      note('src', { match: { files: ['src/**'] } }),
    ]
    const cited = (overrides: Partial<ResolveGuideInput>, files?: string[]) =>
      ['fam', 'src'].filter((id) =>
        resolveGuide(
          input({ notes: { entries, kind: 'review', ...(files && { files }) }, ...overrides }),
        ).text.includes(`[kb:${id}]`),
      )
    expect(cited({ family: { id: 'f1', name: 'Discs' } }, ['src/disc.ts'])).toEqual(['fam', 'src'])
    expect(cited({ family: { id: 'f2', name: 'Squares' } }, ['docs/disc.md'])).toEqual([])
    expect(cited({})).toEqual(['src'])
  })

  test('notes are ranked by the semantic cosines when given', () => {
    const entries = [note('first'), note('second'), note('third')]
    const order = (semantic?: ReadonlyMap<string, number>) => {
      const text = resolveGuide(
        input({ notes: { entries, kind: 'review', ...(semantic && { semantic }) } }),
      ).text
      return ['first', 'second', 'third'].toSorted(
        (a, b) => text.indexOf(`[kb:${a}]`) - text.indexOf(`[kb:${b}]`),
      )
    }
    const semantic = new Map([
      ['third', 0.9],
      ['first', 0.5],
    ])
    expect(order(semantic)).toEqual(['third', 'first', 'second'])
    expect(order(new Map([['second', 0.9]]))[0]).toBe('second')
  })

  test('notes respect maxChars and the default caps hold', () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      note(`n${i}`, { body: `Body ${i} `.repeat(40) }),
    )
    const limited = resolveGuide(input({ notes: { entries, kind: 'review', maxChars: 1000 } }))
    expect(limited.budget.notesUsed).toBeLessThanOrEqual(1000)
    const full = resolveGuide(input({ notes: { entries, kind: 'review' } }))
    expect(full.text.length).toBeLessThanOrEqual(12_000)
    expect(full.text.length).toBeGreaterThan(10_000)
  })
})

const forSquare = (id: string, overrides: Partial<KnowledgeEntry> = {}) =>
  note(id, { scope: { repos: ['work:acme/square/web'] }, ...overrides })

describe('neighbours', () => {
  const square = { forge: 'work', path: 'acme/square/web', teams: ['shapes'] }

  test('knowledge of similar repositories comes last, in its own block', () => {
    const resolved = resolveGuide(
      input({
        notes: {
          entries: [note('own'), forSquare('near')],
          kind: 'review',
          neighbours: { repos: [{ repo: square, similarity: 0.8 }] },
        },
      }),
    )
    const [notes, near] = positions(resolved.text, [
      '## Team knowledge',
      '## Knowledge from similar repositories',
    ])
    expect(notes).toBeGreaterThan(0)
    expect(near).toBeGreaterThan(notes ?? 0)
    expect(resolved.text).toContain('### [kb:near] Note near')
    expect(resolved.text).toContain('written for acme/square/web (similarity 0.80)')
    const block = resolved.blocks.find((b) => b.layer === 'neighbours')
    expect(block).toMatchObject({ source: 'Similar repositories: acme/square/web', cut: false })
    expect(resolved.blocks.at(-1)?.layer).toBe('neighbours')
    expect(resolved.budget.neighboursUsed).toBe(block?.chars ?? -1)
    expect(resolved.budget.notesUsed).toBeGreaterThan(resolved.budget.neighboursUsed)
    expect(resolved.blocks.map((b) => b.text).join('')).toBe(
      resolved.text.slice(resolved.text.indexOf('## ')) + '\n\n',
    )
  })

  test('uses only the entries given, and nothing without neighbours', () => {
    const notes = { entries: [forSquare('near')], kind: 'review' }
    const repos = [{ repo: square, similarity: 0.8 }]
    expect(resolveGuide(input({ notes })).blocks.some((b) => b.layer === 'neighbours')).toBeFalse()
    expect(
      resolveGuide(input({ notes: { ...notes, neighbours: { repos, entries: [] } } })).text,
    ).not.toContain('kb:near')
  })

  test('takes at most its share of the budget and is cut first', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      forSquare(`n${i}`, { body: `Body ${i} `.repeat(40) }),
    )
    const repos = [{ repo: square, similarity: 0.8 }]
    const resolved = resolveGuide(
      input({ notes: { entries, kind: 'review', neighbours: { repos } } }),
    )
    expect(resolved.budget.neighboursUsed).toBeLessThanOrEqual(GUIDE_CAPS.total * 0.15)
    expect(resolved.blocks.find((b) => b.layer === 'neighbours')?.cut).toBeTrue()
    const own = Array.from({ length: 50 }, (_, i) =>
      note(`own${i}`, { body: `Body ${i} `.repeat(40) }),
    )
    const crowded = resolveGuide(
      input({ notes: { entries: [...own, ...entries], kind: 'review', neighbours: { repos } } }),
    )
    expect(crowded.budget.neighboursUsed).toBe(0)
    expect(crowded.text.length).toBeLessThanOrEqual(GUIDE_CAPS.total)
  })
})

describe('folders and teams', () => {
  const titles: Record<string, string> = { widgets: 'Widget crew (widgets)' }
  const teamTitle = (key: string) => titles[key] ?? key

  test('folders sit between the family and the owner teams, deepest first, with labelled titles', () => {
    const resolved = resolveGuide(
      input({
        task: 'chat',
        family: { id: 'f1', name: 'Discs' },
        teamTitle,
        sections: [
          row({ scope: 'all', rules: 'ALL rule.' }),
          row({ scope: 'team:gizmo', rules: 'GIZMO rule.' }),
          row({ scope: 'team:widgets', rules: 'WIDGETS rule.' }),
          row({ scope: 'path:work:acme', rules: 'ACME rule.' }),
          row({ scope: 'path:work:acme/round', rules: 'ROUND rule.' }),
          row({ scope: 'path:work:acme/round/web', rules: 'SELF FOLDER rule.' }),
          row({ scope: 'family:f1', rules: 'FAMILY rule.' }),
          row({ scope: 'repo:work:acme/round/web', rules: 'REPO rule.' }),
        ],
      }),
    )
    expect(resolved.text).not.toContain('SELF FOLDER')
    const order = positions(resolved.text, [
      'REPO rule',
      'FAMILY rule',
      'ROUND rule',
      'ACME rule',
      'WIDGETS rule',
      'GIZMO rule',
      'ALL rule',
    ])
    expect(order.every((at) => at >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    expect(resolved.blocks.map((block) => [block.layer, block.scope, block.source])).toEqual([
      ['repo', 'repo:work:acme/round/web', 'This repository'],
      ['family', 'family:f1', 'Family Discs'],
      ['path', 'path:work:acme/round', 'Folder acme/round'],
      ['path', 'path:work:acme', 'Folder acme'],
      ['team', 'team:widgets', 'Team Widget crew (widgets)'],
      ['team', 'team:gizmo', 'Team gizmo'],
      ['all', 'all', 'All repositories'],
    ])
    expect(resolved.text).toContain('## Rules for folder acme/round\n')
    expect(resolved.text).toContain('## Team rules for team Widget crew (widgets)')
  })

  test('without a labeler titles name the team key', () => {
    const resolved = resolveGuide(
      input({ task: 'chat', sections: [row({ scope: 'team:widgets', rules: 'TEAM rule.' })] }),
    )
    expect(resolved.text).toContain('## Team rules for team widgets')
  })

  test('over the human budget cuts all, then teams, then folders, then the family', () => {
    const sections = [
      row({ scope: 'repo:work:acme/round/web', rules: 'R'.repeat(400) }),
      row({ scope: 'family:f1', rules: 'F'.repeat(400) }),
      row({ scope: 'path:work:acme/round', rules: 'S'.repeat(400) }),
      row({ scope: 'team:widgets', rules: 'P'.repeat(400) }),
      row({ scope: 'all', rules: 'A'.repeat(400) }),
    ]
    const resolveWith = (human: number) =>
      resolveGuide(
        input({
          task: 'chat',
          family: { id: 'f1', name: 'Discs' },
          caps: { total: 4000, human, generated: 500 },
          sections,
        }),
      )
    const kept = (human: number) =>
      resolveWith(human)
        .blocks.filter((block) => block.chars > 0 && !block.cut)
        .map((block) => block.layer)
    const full = resolveWith(4000).budget.humanUsed
    expect(kept(4000)).toEqual(['repo', 'family', 'path', 'team', 'all'])
    expect(kept(full - 300)).toEqual(['repo', 'family', 'path', 'team'])
    expect(kept(full - 750)).toEqual(['repo', 'family', 'path'])
    expect(kept(full - 1200)).toEqual(['repo', 'family'])
    expect(kept(full - 1650)).toEqual(['repo'])
  })
})

describe('repository files and block texts', () => {
  test('rules files form one repo-file layer first, and block texts add up to the prompt', () => {
    const resolved = resolveGuide(
      input({
        task: 'chat',
        section: 'testing',
        repoDocs: [
          { file: 'REVIEW.md', text: 'Flag widgets without a ShapeBase.' },
          { file: 'AGENTS.md', text: 'Run bun test before pushing.' },
        ],
        sections: [
          row({ scope: 'repo:work:acme/round/web', rules: 'REPO rule.' }),
          row({ scope: 'all', section: 'testing', rules: 'ALL testing rule.' }),
          row({
            scope: 'repo:work:acme/round/web',
            section: 'testing',
            generated: {
              version: 3,
              body: '- Generated testing line.',
              inputHash: 'h',
              model: 'm',
              costUsd: 0,
              status: 'accepted',
              generatedAt: '2026-11-01T10:00:00.000Z',
            },
          }),
        ],
      }),
    )
    expect(resolved.blocks.map((block) => [block.layer, block.source])).toEqual([
      ['repo-file', 'REVIEW.md · AGENTS.md'],
      ['repo', 'This repository'],
      ['all', 'All repositories'],
      ['generated', 'Generated Testing'],
    ])
    expect(resolved.blocks.find((block) => block.layer === 'generated')?.version).toBe(3)
    const header = resolved.text.indexOf('## Rules from the repository')
    expect(resolved.text.slice(header)).toBe(
      resolved.blocks
        .map((block) => block.text)
        .join('')
        .trimEnd(),
    )
    expect(resolved.blocks.every((block) => block.chars === block.text.length)).toBe(true)
  })

  test('focus reads only the given sections whatever the task', () => {
    const sections = [
      row({ scope: 'all', rules: 'GENERAL rule.' }),
      row({ scope: 'all', section: 'review', rules: 'REVIEW rule.' }),
    ]
    const focused = resolveGuide(input({ task: 'review', focus: ['review'], sections }))
    expect(focused.sections).toEqual(['review'])
    expect(focused.text).toContain('REVIEW rule')
    expect(focused.text).not.toContain('GENERAL rule')
  })
})

describe('cutText', () => {
  test('cuts at a line break within the limit and marks the cut', () => {
    expect(cutText('short', 10)).toBe('short')
    const cut = cutText('first line\nsecond line\nthird line', 25)
    expect(cut).toBe('first line\nsecond line\n[...]'.replace('\nsecond line', ''))
    expect(cut.length).toBeLessThanOrEqual(25)
    expect(cutText('abc', 2)).toBe('')
  })
})
