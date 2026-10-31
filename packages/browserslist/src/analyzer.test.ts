import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner, runChecked } from '@holtkeeper/exec'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { GitForge } from '@holtkeeper/forge'

import {
  browserslistOptionsSchema,
  caniuseVersions,
  createBrowserslistAnalyzer,
} from './analyzer.ts'
import { browserslistReport } from './report.ts'

const lockfile = (version: string) =>
  `{\n  "packages": {\n    "caniuse-lite": ["caniuse-lite@${version}", "", {}, "sha512"],\n  }\n}\n`

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function repository(files: Record<string, string>) {
  dir = await mkdtemp(join(tmpdir(), 'browserslist-'))
  for (const [path, text] of Object.entries(files)) await writeFile(join(dir, path), text)
  const git = (...args: string[]) => runChecked(localRunner, ['git', ...args], { cwd: dir! })
  await git('init', '-q')
  await git('add', '.')
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

function fakeForge(refusals = 0) {
  const commits: unknown[] = []
  const merges: unknown[] = []
  const created: { title: string; description?: string; sourceBranch: string }[] = []
  const forge = {
    getRepository: async () => ({ defaultBranch: 'main' }),
    findMergeRequest: async () => undefined,
    readFile: async () => undefined,
    commit: async (_repo: string, input: unknown) => {
      commits.push(input)
      return { sha: 'abc' }
    },
    createMergeRequest: async (_repo: string, input: (typeof created)[number]) => {
      created.push(input)
      return { id: 7, webUrl: 'https://forge.test/mr/7', draft: false }
    },
    mergeMergeRequest: async (_repo: string, id: number, options: unknown) => {
      merges.push({ id, options })
      if (merges.length <= refusals) throw new Error('405 Method Not Allowed')
    },
  } as unknown as GitForge
  return { forge, commits, created, merges }
}

const run = async (root: string, forge: GitForge, options: Record<string, unknown> = {}) => {
  const fake = createFakeRunner(async (command, { cwd }) => {
    if (command[0] === 'bunx') {
      await writeFile(join(cwd, 'bun.lock'), lockfile('1.0.30001700'))
      return { stdout: 'Latest version:     1.0.30001700' }
    }
    if (command[1] === '-e') {
      const current = await Bun.file(join(root, 'bun.lock')).text()
      return {
        stdout: JSON.stringify(
          current.includes('1.0.30001700')
            ? ['chrome 130', 'firefox 132']
            : ['chrome 129', 'firefox 132'],
        ),
      }
    }
    return undefined
  })
  const analyzer = createBrowserslistAnalyzer({
    now: () => new Date('2026-10-31T00:00:00Z'),
    sleep: async () => {},
  })
  const result = await analyzer.run({
    repo: { forge: 'work', path: 'games/app' },
    forge,
    runner: localRunner,
    checkout: async () => ({
      dir: root,
      sha: 'head',
      ref: 'main',
      cleanup: async () => {},
      runner: fake.runner,
    }),
    options: browserslistOptionsSchema.parse(options),
  })
  return { ...result, calls: fake.calls.map((call) => call.command.slice(0, 2).join(' ')) }
}

describe('browserslist analyzer', () => {
  test('caniuseVersions reads every version from lockfile text', () => {
    expect(caniuseVersions(`${lockfile('1.0.30001700')}\n"x": "1.0.30001600"`)).toEqual([
      '1.0.30001600',
      '1.0.30001700',
    ])
  })

  test('updates the lockfile and proposes it with the browsers that changed', async () => {
    const root = await repository({ 'package.json': '{}', 'bun.lock': lockfile('1.0.30001600') })
    const { forge, commits, created } = fakeForge()
    const { data, calls } = await run(root, forge)

    expect(data.status).toBe('updated')
    expect([data.before, data.after]).toEqual([['1.0.30001600'], ['1.0.30001700']])
    expect(data.files).toEqual(['bun.lock'])
    expect(data.targets).toEqual([
      { dir: '.', before: ['chrome 129', 'firefox 132'], after: ['chrome 130', 'firefox 132'] },
    ])
    expect(calls).toEqual([
      'bun install',
      'bun -e',
      'bunx update-browserslist-db@latest',
      'bun install',
      'bun -e',
    ])
    expect(commits).toHaveLength(1)
    expect(created[0]?.sourceBranch).toBe('holtkeeper/browserslist')
    expect(created[0]?.title).toBe(
      'chore(deps): update browserslist database to caniuse-lite 1.0.30001700',
    )
    expect(created[0]?.description).toContain('`chrome 130`')
    expect(created[0]?.description).toContain('`chrome 129`')
    expect(data.mergeRequest).toEqual({ id: 7, url: 'https://forge.test/mr/7', draft: false })
    expect(browserslistReport(data).metrics.find((m) => m.id === 'browsers')?.value).toBe(2)
  })

  test('takes the commit message from a template', async () => {
    const root = await repository({ 'package.json': '{}', 'bun.lock': lockfile('1.0.30001600') })
    const { forge, created } = fakeForge()
    await run(root, forge, { commitMessage: 'chore: [GTW-1] caniuse-lite {version}', dirs: [] })

    expect(created[0]?.title).toBe('chore: [GTW-1] caniuse-lite 1.0.30001700')
  })

  test('sets auto-merge on the merge request, retrying while the forge refuses', async () => {
    const root = await repository({ 'package.json': '{}', 'bun.lock': lockfile('1.0.30001600') })
    const { forge, merges } = fakeForge(1)
    const { data } = await run(root, forge, { autoMerge: true, dirs: [] })

    expect(merges).toEqual([
      { id: 7, options: { whenPipelineSucceeds: true, removeSourceBranch: true } },
      { id: 7, options: { whenPipelineSucceeds: true, removeSourceBranch: true } },
    ])
    expect(data.mergeRequest?.autoMerge).toBe('set')
  })

  test('records auto-merge as failed when the forge keeps refusing', async () => {
    const root = await repository({ 'package.json': '{}', 'bun.lock': lockfile('1.0.30001600') })
    const { forge, merges } = fakeForge(3)
    const { data } = await run(root, forge, { autoMerge: true, dirs: [] })

    expect(merges).toHaveLength(3)
    expect(data.status).toBe('updated')
    expect(data.mergeRequest?.autoMerge).toBe('failed')
  })

  test('dry runs and repositories without caniuse-lite publish nothing', async () => {
    const root = await repository({ 'package.json': '{}', 'bun.lock': lockfile('1.0.30001600') })
    const { forge, created } = fakeForge()
    const dry = await run(root, forge, { dryRun: true, dirs: [] })
    expect(dry.data.status).toBe('updated')
    expect(dry.calls).toEqual(['bunx update-browserslist-db@latest'])
    expect(created).toEqual([])
    await rm(root, { recursive: true, force: true })

    const plain = await repository({ 'package.json': '{}', 'bun.lock': '{}' })
    const { data, calls } = await run(plain, forge)
    expect(data.status).toBe('not-applicable')
    expect(calls).toEqual([])
  })
})
