import { describe, expect, test } from 'bun:test'

import type { Discussion, GitForge, MergeRequestRecord } from '@holtkeeper/forge'

import {
  MR_CHARS,
  MR_ITEM_CHARS,
  collectMergeRequestEvidence,
  isBot,
  isDependencyUpdate,
  renderDiscussions,
  stripTemplate,
} from './evidence-mr.ts'

const mr = (id: number, overrides: Partial<MergeRequestRecord> = {}): MergeRequestRecord => ({
  id,
  title: `Add widget endpoint ${id}`,
  description: '',
  sourceBranch: `feature/${id}`,
  targetBranch: 'main',
  state: 'merged',
  draft: false,
  labels: [],
  author: 'dev-one',
  webUrl: `https://forge.test/acme/widget-api/-/merge_requests/${id}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  mergedAt: '2026-10-02T00:00:00.000Z',
  ...overrides,
})

const note = (author: string, body: string, system = false) => ({
  id: `${author}-${body.length}`,
  author,
  body,
  createdAt: '2026-10-01T00:00:00.000Z',
  system,
})

const thread = (
  notes: ReturnType<typeof note>[],
  position?: Discussion['position'],
): Discussion => ({
  id: `d-${notes.length}-${notes[0]?.body.length ?? 0}`,
  resolvable: true,
  resolved: true,
  notes,
  ...(position && { position }),
})

function fakeForge(
  records: MergeRequestRecord[],
  discussions: Record<number, Discussion[] | Error> = {},
) {
  const calls: string[] = []
  const forge: Pick<GitForge, 'listMergeRequests' | 'listDiscussions'> = {
    async listMergeRequests(repo, query) {
      calls.push(`list ${repo} ${query?.state} ${query?.updatedAfter} ${query?.limit}`)
      return records
    },
    async listDiscussions(_repo, id) {
      calls.push(`discussions ${id}`)
      const found = discussions[id]
      if (found instanceof Error) throw found
      return found ?? []
    },
  }
  return { forge, calls }
}

const since = new Date('2026-05-13T00:00:00.000Z')
const base = { repo: 'acme/widget-api', since, maxMergeRequests: 60, discussionMergeRequests: 25 }

describe('collectMergeRequestEvidence', () => {
  test('keeps merged merge requests of the window without bots and dependency updates', async () => {
    const { forge, calls } = fakeForge([
      mr(1, { mergedAt: '2026-10-03T00:00:00.000Z', description: 'Adds the endpoint.' }),
      mr(2, { mergedAt: '2026-04-01T00:00:00.000Z', description: 'Too old.' }),
      mr(3, { author: 'renovate-bot', description: 'Bot.' }),
      mr(4, { title: 'chore(deps): update module example.com/kit to v1.3.0', description: 'x' }),
      mr(5, { author: 'holtkeeper', description: 'Ours.' }),
      mr(6, { mergedAt: undefined, state: 'closed' }),
      mr(7, { mergedAt: '2026-10-05T00:00:00.000Z', labels: ['api'], description: 'Newest.' }),
    ])
    const result = await collectMergeRequestEvidence({ ...base, forge, botUsername: 'holtkeeper' })
    expect(result.listed).toBeTrue()
    expect(result.mergeRequests.map((item) => item.id)).toEqual([7, 1])
    expect(result.evidence.map((item) => item.id)).toEqual(['mr-titles', 'mr:7', 'mr:1'])
    expect(result.evidence[0]?.text).toBe(
      '!7 Add widget endpoint 7 [api]\n!1 Add widget endpoint 1',
    )
    expect(calls[0]).toBe('list acme/widget-api merged 2026-05-13T00:00:00.000Z 60')
    expect(calls.slice(1)).toEqual(['discussions 7', 'discussions 1'])
    expect(result.discussions).toBe(2)
  })

  test('renders descriptions without templates and anonymised review threads', async () => {
    const { forge } = fakeForge(
      [
        mr(9, {
          author: 'dev-one',
          description:
            '## What\nMoves retries into kit.\n## Checklist\n- [x] tests\n<!-- template -->\n## Notes\n',
        }),
      ],
      {
        9: [
          thread([note('dev-two', 'Nice.')]),
          thread([note('dev-three', 'Use kit.Retry here, not a loop.'), note('dev-one', 'Done.')], {
            path: 'internal/widget/store.go',
            line: 42,
            side: 'new',
            headSha: 'abc',
          }),
          thread([note('ci-runner', 'assigned to @dev-two', true)]),
          thread([note('holtkeeper', 'Automated review comment.')]),
        ],
      },
    )
    const result = await collectMergeRequestEvidence({ ...base, forge, botUsername: 'holtkeeper' })
    const item = result.evidence.find((entry) => entry.id === 'mr:9')
    expect(item?.label).toBe('!9 Add widget endpoint 9')
    expect(item?.text).toBe(
      [
        'Description:',
        '## What',
        'Moves retries into kit.',
        '',
        'Review threads:',
        '- internal/widget/store.go:42 reviewer 2: Use kit.Retry here, not a loop.',
        '  author: Done.',
        '- reviewer 1: Nice.',
      ].join('\n'),
    )
    expect(item?.text).not.toContain('dev-')
  })

  test('respects the caps and the discussion limit, skips empty merge requests', async () => {
    const long = 'word '.repeat(2_000)
    const records = Array.from({ length: 40 }, (_, index) =>
      mr(index + 1, {
        mergedAt: `2026-10-${String((index % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
        description: index === 0 ? '' : long,
      }),
    )
    const { forge, calls } = fakeForge(records)
    const result = await collectMergeRequestEvidence({
      ...base,
      forge,
      discussionMergeRequests: 30,
    })
    const total = result.evidence.reduce((sum, item) => sum + item.text.length, 0)
    expect(total).toBeLessThanOrEqual(MR_CHARS)
    for (const item of result.evidence) expect(item.text.length).toBeLessThanOrEqual(5_000)
    expect(
      result.evidence
        .filter((item) => item.id.startsWith('mr:'))
        .every((item) => item.text.length <= MR_ITEM_CHARS),
    ).toBeTrue()
    expect(result.evidence.some((item) => item.id === 'mr:1')).toBeFalse()
    expect(calls.filter((call) => call.startsWith('discussions')).length).toBeLessThanOrEqual(30)

    const none = await collectMergeRequestEvidence({ ...base, forge, discussionMergeRequests: 0 })
    expect(none.evidence.map((item) => item.id)).toEqual(['mr-titles'])
    expect(none.discussions).toBe(0)
  })

  test('a failing discussions read is logged; a forge without merge requests gives nothing', async () => {
    const lines: string[] = []
    const { forge } = fakeForge([mr(3, { description: 'Kept.' })], { 3: new Error('403') })
    const result = await collectMergeRequestEvidence({ ...base, forge, log: (l) => lines.push(l) })
    expect(result.evidence.map((item) => item.id)).toEqual(['mr-titles', 'mr:3'])
    expect(lines).toEqual(['merge request !3: discussions not read (403)'])

    const bare = await collectMergeRequestEvidence({
      ...base,
      forge: {},
      log: (l) => lines.push(l),
    })
    expect(bare).toEqual({ evidence: [], mergeRequests: [], discussions: 0, listed: false })
    expect(lines.at(-1)).toContain('cannot list them')
  })
})

describe('helpers', () => {
  test('isBot and isDependencyUpdate', () => {
    expect(isBot('renovate[bot]')).toBeTrue()
    expect(isBot('project_12_bot_3f2a')).toBeTrue()
    expect(isBot('ci-bot')).toBeTrue()
    expect(isBot('robert')).toBeFalse()
    expect(isBot('holtkeeper', 'holtkeeper')).toBeTrue()
    expect(isDependencyUpdate('chore(deps): update dependency some-lib to v2')).toBeTrue()
    expect(isDependencyUpdate('Bump example.com/kit from 1.0 to 1.1')).toBeTrue()
    expect(isDependencyUpdate('Update dependency other-lib')).toBeTrue()
    expect(isDependencyUpdate('feat: bump widget limits')).toBeFalse()
  })

  test('stripTemplate keeps headings with text under them', () => {
    expect(stripTemplate('# Summary\nFixes it.\n# Checklist\n- [ ] docs\n- [x] tests\n')).toBe(
      '# Summary\nFixes it.',
    )
  })

  test('renderDiscussions cuts long code blocks', () => {
    const code = `\`\`\`go\n${'x := 1\n'.repeat(60)}\`\`\``
    expect(renderDiscussions([thread([note('dev-two', `See:\n${code}`)])], 'dev-one')).toEqual([
      '- reviewer 1: See: ``` [code cut] ```',
    ])
  })
})
