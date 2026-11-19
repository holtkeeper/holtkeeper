import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner, runChecked } from '@holtkeeper/exec'
import { createFakeRunner } from '@holtkeeper/exec/testing'

import { branchApiChanges, branchApiHeading } from './branch.ts'

const noGit = !Bun.which('git')
let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const git = (...args: string[]) =>
  runChecked(localRunner, ['git', ...args], {
    cwd: dir!,
    env: {
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })

const write = async (path: string, content: string) => {
  await mkdir(join(dir!, path, '..'), { recursive: true })
  await writeFile(join(dir!, path), content)
}

async function widgetsRepo() {
  dir = await mkdtemp(join(tmpdir(), 'api-branch-'))
  await git('init', '-q')
  await write('package.json', JSON.stringify({ private: true, workspaces: ['packages/*'] }))
  await write(
    'packages/widgets/package.json',
    JSON.stringify({ name: '@acme/widgets', version: '1.2.0', exports: './src/index.ts' }),
  )
  await write(
    'packages/widgets/src/index.ts',
    [
      'export function makeWidget(size: number): string {',
      "  return 'w'.repeat(size)",
      '}',
      'export const paintWidget = (color: string): void => {}',
      'export function spinWidget(): void {}',
    ].join('\n'),
  )
  await write('README.md', '# Widgets\n')
  await git('add', '.')
  await git('commit', '-qm', 'base')
  const base = (await git('rev-parse', 'HEAD')).stdout.trim()
  await write(
    'packages/widgets/src/index.ts',
    [
      'export function makeWidget(size: number, label: string): string {',
      '  return label.repeat(size)',
      '}',
      'export function spinWidget(): void {}',
      'export function foldWidget(times: number): void {}',
    ].join('\n'),
  )
  await write('README.md', '# Widgets, folded\n')
  await git('commit', '-qam', 'head')
  return base
}

test.skipIf(noGit)(
  'reports removed, changed and added exports and removes the worktree',
  async () => {
    const baseSha = await widgetsRepo()
    const section = await branchApiChanges({
      dir: dir!,
      baseSha,
      changedFiles: ['packages/widgets/src/index.ts', 'README.md'],
      runner: localRunner,
    })
    expect(section).toBeDefined()
    expect(section!.startsWith(branchApiHeading)).toBe(true)
    expect(section).toContain('`@acme/widgets` (npm')
    expect(section).toContain('- removed `paintWidget` (')
    expect(section).toContain(
      '- changed `makeWidget` (function) at `packages/widgets/src/index.ts:1`',
    )
    expect(section).toContain('label: string')
    expect(section).toContain(
      '- added `foldWidget` (function) at `packages/widgets/src/index.ts:5`',
    )
    expect(section).toContain('**major**')
    expect(section).toContain('did not change (1.2.0)')
    expect(section).toContain('call package_usage (with `export` for the code of the uses)')
    const worktrees = (await git('worktree', 'list')).stdout.trim().split('\n')
    expect(worktrees).toHaveLength(1)
  },
)

test.skipIf(noGit)('cuts the section at maxChars and filters by consumed', async () => {
  const baseSha = await widgetsRepo()
  const options = {
    dir: dir!,
    baseSha,
    changedFiles: ['packages/widgets/src/index.ts'],
    runner: localRunner,
  }
  const short = await branchApiChanges({ ...options, maxChars: 500 })
  expect(short!.length).toBeLessThanOrEqual(500)
  expect(short).toMatch(/… \d+ more changes?/)
  const filtered = await branchApiChanges({ ...options, consumed: () => false })
  expect(filtered).toBeUndefined()
})

test.skipIf(noGit)('is undefined when no changed file sits in a package', async () => {
  const baseSha = await widgetsRepo()
  const fake = createFakeRunner()
  const section = await branchApiChanges({
    dir: dir!,
    baseSha,
    changedFiles: ['README.md', 'docs/guide.md'],
    runner: fake.runner,
  })
  expect(section).toBeUndefined()
  expect(fake.calls).toHaveLength(0)
})

test.skipIf(noGit)('is undefined for an unknown base commit', async () => {
  await widgetsRepo()
  const section = await branchApiChanges({
    dir: dir!,
    baseSha: '0123456789abcdef0123456789abcdef01234567',
    changedFiles: ['packages/widgets/src/index.ts'],
    runner: localRunner,
  })
  expect(section).toBeUndefined()
  const worktrees = (await git('worktree', 'list')).stdout.trim().split('\n')
  expect(worktrees).toHaveLength(1)
})
