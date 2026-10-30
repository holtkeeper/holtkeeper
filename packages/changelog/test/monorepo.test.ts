import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner, runChecked } from '@holtkeeper/exec'

import { analyzeChangelog, changelogAnalysis, changelogDataSchema } from '../src/index.ts'

let dir = ''

async function git(args: string[], date: string) {
  await runChecked(
    localRunner,
    ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    {
      cwd: dir,
      env: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    },
  )
}

async function commit(subject: string, date: string) {
  await Bun.write(join(dir, `${Bun.hash(subject + date)}.txt`), `${subject}\n`, {
    createPath: true,
  })
  await git(['add', '-A'], date)
  await git(['commit', '-q', '-m', subject], date)
}

const shas: Record<string, string> = {}
const head = async (name: string) => {
  const { stdout } = await runChecked(localRunner, ['git', 'rev-parse', 'HEAD'], { cwd: dir })
  shas[name] = stdout.trim()
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-monorepo-'))
  await git(['init', '-q', '-b', 'main'], '2026-10-01T00:00:00Z')
  await git(['config', 'user.name', 'Ann Lee'], '2026-10-01T00:00:00Z')
  await git(['config', 'user.email', 'ann@example.com'], '2026-10-01T00:00:00Z')

  await commit('chore: Version Packages', '2026-10-01T09:00:00Z')
  await head('first')
  await git(['tag', '@ui/card@0.6.0'], '2026-10-01T09:00:00Z')
  await git(['tag', '@ui/chip@1.5.0'], '2026-10-01T09:00:00Z')

  await commit('feat(card): flip animation', '2026-10-02T09:00:00Z')
  await commit('fix(common): shared deps', '2026-10-02T10:00:00Z')
  await commit('chore: Version Packages', '2026-10-02T11:00:00Z')
  await head('second')
  await git(['tag', '@ui/card@0.7.0'], '2026-10-02T11:00:00Z')
  await git(['tag', '@ui/common@1.0.0'], '2026-10-02T11:00:00Z')
})

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!Bun.which('git'))('monorepo releases', () => {
  test('every package tag of a commit describes the same release', async () => {
    const byTag = await analyzeChangelog({ dir, to: '@ui/common@1.0.0' })
    const bySha = await analyzeChangelog({ dir, to: shas.second! })
    expect(bySha).toEqual(byTag)
    expect(byTag.to).toMatchObject({
      name: shas.second,
      tags: ['@ui/card@0.7.0', '@ui/common@1.0.0'],
    })
    expect(byTag.from).toMatchObject({
      name: shas.first,
      tags: ['@ui/card@0.6.0', '@ui/chip@1.5.0'],
    })
    expect(byTag.commits.map((c) => c.subject)).toEqual([
      'chore: Version Packages',
      'fix(common): shared deps',
      'feat(card): flip animation',
    ])
    expect(byTag.packages).toEqual([
      { name: '@ui/card', version: '0.7.0', tag: '@ui/card@0.7.0', previous: '0.6.0' },
      { name: '@ui/common', version: '1.0.0', tag: '@ui/common@1.0.0' },
    ])
    expect(changelogDataSchema.parse(JSON.parse(JSON.stringify(byTag)))).toEqual(byTag)
  })

  test('the report names the release by its packages', async () => {
    const data = await analyzeChangelog({ dir, to: shas.second! })
    const report = changelogAnalysis.toReport({
      id: 'r',
      repo: { forge: 'work', path: 'ui/libs' },
      kind: 'changelog',
      ref: shas.second!,
      createdAt: data.to.date,
      data,
    })
    expect(report.title).toBe('Release of 2 packages')
    expect(report.subtitle).toBe(
      `${shas.first!.slice(0, 8)} → ${shas.second!.slice(0, 8)} · 3 commits`,
    )
    expect(report.metrics[0]).toMatchObject({ id: 'packages', value: 2 })
    const packages = report.sections[0]!
    expect(packages.id).toBe('packages')
    const table = packages.blocks[0]!
    expect(table.type === 'table' && table.rows.map((row) => row.bump)).toEqual([
      { text: 'minor', tone: 'good' },
      { text: 'new', tone: 'info' },
    ])

    const first = await analyzeChangelog({ dir, to: '@ui/chip@1.5.0' })
    expect(first.from).toBeUndefined()
    expect(changelogAnalysis.toReport(record(first)).title).toBe('Release of 2 packages')
  })
})

const record = (data: Awaited<ReturnType<typeof analyzeChangelog>>) => ({
  id: 'r',
  repo: { forge: 'work', path: 'ui/libs' },
  kind: 'changelog',
  ref: data.to.name,
  createdAt: data.to.date,
  data,
})
