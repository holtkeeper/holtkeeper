import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner, runChecked } from '@holtkeeper/exec'
import type { Block } from '@holtkeeper/report'

import {
  analyzeChangelog,
  type ChangelogData,
  changelogAnalysis,
  changelogDataSchema,
  forgeLinks,
  gitHistory,
} from '../src/index.ts'

let dir = ''

async function git(args: string[], date?: string) {
  await runChecked(
    localRunner,
    ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    {
      cwd: dir,
      env: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
    },
  )
}

async function commit(subject: string, date: string, author: [string, string], body = '') {
  await Bun.write(join(dir, 'log.txt'), `${subject}\n${date}\n`, { createPath: true })
  await Bun.write(join(dir, `${Bun.hash(subject + date)}.txt`), 'x\n'.repeat(3))
  await git(['add', '-A'])
  await git(
    [
      '-c',
      `user.name=${author[0]}`,
      '-c',
      `user.email=${author[1]}`,
      'commit',
      '-q',
      '-m',
      subject,
      ...(body ? ['-m', body] : []),
    ],
    date,
  )
}

const ann: [string, string] = ['Ann Lee', 'ann@example.com']
const bob: [string, string] = ['Борис', 'bob@example.com']
const links = forgeLinks({
  kind: 'gitlab',
  webUrl: 'https://gitlab.example.com/games/slots',
  ticketUrl: 'https://jira.example.com/browse/{id}',
})

const record = (data: ChangelogData, ref: string) => ({
  id: ref,
  repo: { forge: 'work', path: 'games/slots' },
  kind: 'changelog',
  ref,
  createdAt: data.to.date,
  data,
})

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-changelog-'))
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.name', 'Ann Lee'])
  await git(['config', 'user.email', 'ann@example.com'])

  await Bun.write(join(dir, 'README.md'), 'Slots\n'.repeat(20))
  await commit('chore: initial import', '2026-10-01T09:00:00Z', ann)
  await git(['tag', '-a', 'v1.0.0', '-m', 'Release 1.0.0'], '2026-10-01T10:00:00Z')

  await commit('feat: [GTW-435] add passkeys', '2026-10-02T09:00:00Z', ann)
  await commit('fix(upload): retry upload', '2026-10-02T12:00:00Z', bob)
  await commit('fix(upload): Retry upload.', '2026-10-03T09:00:00Z', ann)
  await commit('fix(upload): [GTW-500] retry upload', '2026-10-03T11:00:00Z', bob)
  await commit(
    'docs: Обновил README',
    '2026-10-04T09:00:00Z',
    bob,
    'Co-authored-by: Ann Lee <ann@example.com>',
  )
  await commit(
    'feat(api)!: drop v1 endpoints',
    '2026-10-04T15:00:00Z',
    ann,
    'BREAKING CHANGE: /v1 is gone',
  )
  await git(
    ['tag', '-a', 'v1.1.0', '-m', 'Release 1.1.0\n\nPasskeys and upload retries.'],
    '2026-10-05T10:00:00Z',
  )

  await git(['mv', 'README.md', 'docs.md'])
  await Bun.write(join(dir, 'logo.bin'), new Uint8Array([0, 1, 2, 0, 255]))
  await commit('fix: after release', '2026-10-06T09:00:00Z', ann)
})

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const blocksOf = (blocks: Block[], type: Block['type']) =>
  blocks.filter((block) => block.type === type)

describe.skipIf(!Bun.which('git'))('changelog of a real repository', () => {
  test('lists tags newest first', async () => {
    const refs = await gitHistory().listRefs(dir)
    expect(refs.map((ref) => ref.name)).toEqual(['v1.1.0', 'v1.0.0'])
    expect(refs[0]!.message).toContain('Passkeys and upload retries.')
  })

  test('defaults `from` to the previous release', async () => {
    const data = await analyzeChangelog({ dir, to: 'v1.1.0', links })
    expect(data.from?.name).toBe('v1.0.0')
    expect(data.to.name).toBe('v1.1.0')
    expect(data.commits).toHaveLength(6)
    expect(data.diff?.files).toBe(7)
    expect(data.links?.commit).toBe('https://gitlab.example.com/games/slots/-/commit/{sha}')
    expect(changelogDataSchema.parse(JSON.parse(JSON.stringify(data)))).toEqual(data)

    const head = await analyzeChangelog({ dir, to: 'HEAD' })
    expect(head.from?.name).toBe('v1.1.0')
    expect(head.commits.map((c) => c.subject)).toEqual(['fix: after release'])
    const files = Object.fromEntries((head.files ?? []).map((file) => [file.path, file]))
    expect(files['docs.md']).toMatchObject({
      status: 'renamed',
      previousPath: 'README.md',
      insertions: 0,
    })
    expect(files['logo.bin']).toMatchObject({ status: 'added', binary: true, insertions: 0 })
    expect(files['log.txt']).toMatchObject({ status: 'modified', insertions: 2, deletions: 2 })
    expect(head.filesTruncated).toBeUndefined()
    expect(data.files).toHaveLength(7)

    const first = await analyzeChangelog({ dir, to: 'v1.0.0' })
    expect(first.from).toBeUndefined()
    expect(first.commits).toHaveLength(1)
  })

  test('builds the report', async () => {
    const current = await analyzeChangelog({ dir, to: 'v1.1.0', links })
    const previous = await analyzeChangelog({ dir, to: 'v1.0.0', links })
    const report = changelogAnalysis.toReport(record(current, 'v1.1.0'), record(previous, 'v1.0.0'))

    expect(report).toMatchObject({
      kind: 'changelog',
      title: 'Changelog v1.1.0',
      subject: { ref: 'v1.1.0', compareTo: 'v1.0.0' },
    })
    const metrics = Object.fromEntries(report.metrics.map((m) => [m.id, m]))
    expect(metrics.commits).toMatchObject({ value: 6, delta: 5 })
    expect(metrics.contributors?.value).toBe(2)
    expect(metrics.features?.value).toBe(1)
    expect(metrics.fixes?.value).toBe(1)
    expect(metrics.breaking).toMatchObject({ value: 1, tone: 'bad' })
    expect(metrics.days?.value).toBe(4)

    expect(report.sections.map((section) => section.id)).toEqual([
      'highlights',
      'changelog',
      'activity',
      'contributors',
      'files',
      'references',
      'compare',
    ])
    const [highlights, changelog, activity, contributors, files, references, compare] =
      report.sections
    const table = files!.blocks[0]!
    expect(table.type === 'table' && table.rows).toHaveLength(7)

    const issues = blocksOf(highlights!.blocks, 'issues')[0]
    expect(issues?.type === 'issues' && issues.items[0]).toMatchObject({
      tone: 'bad',
      title: 'feat(api)!: drop v1 endpoints',
      detail: '/v1 is gone',
    })

    const timelines = changelog!.blocks.flatMap((block) =>
      block.type === 'timeline' ? [block] : [],
    )
    expect(timelines.map((block) => block.title)).toEqual([
      'Breaking changes',
      'Features',
      'Fixes',
      'Docs',
    ])
    const retry = timelines[2]!.items[0]!
    expect(retry.title).toBe('fix(upload): retry upload ×3')
    expect(retry.children).toHaveLength(3)
    expect(retry.tags).toEqual(['upload', 'GTW-500'])
    expect(retry.href).toStartWith('https://gitlab.example.com/games/slots/-/commit/')
    expect(timelines[1]!.items[0]!.tags).toEqual(['GTW-435'])

    const chart = activity!.blocks[0]!
    expect(chart.type === 'chart' && chart.chart).toBe('stacked-bar')
    expect(chart.type === 'chart' && chart.data.map((row) => row.day)).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ])

    const people = contributors!.blocks[0]!
    expect(
      people.type === 'table' && people.rows.map((row) => [row.commits, row.coAuthored]),
    ).toEqual([
      [3, 1],
      [3, 0],
    ])

    const refs = references!.blocks[0]!
    expect(refs.type === 'table' && refs.rows.map((row) => row.ref)).toContainEqual({
      text: 'GTW-435',
      href: 'https://jira.example.com/browse/GTW-435',
    })

    const markdown = compare!.blocks[0]!
    expect(markdown.type === 'markdown' && markdown.text).toContain(
      '[Compare v1.0.0...v1.1.0](https://gitlab.example.com/games/slots/-/compare/v1.0.0...v1.1.0)',
    )
  })
})
