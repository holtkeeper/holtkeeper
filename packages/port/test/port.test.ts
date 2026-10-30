import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import { type CommandRunner, localRunner } from '@holtkeeper/exec'
import type { DiffFile, RepoRef } from '@holtkeeper/forge'
import type { Fixer, Verifier } from '@holtkeeper/propagate'

import { defaultPatchApplier } from '../src/apply.ts'
import { parsePatch } from '../src/patch.ts'
import { runPort } from '../src/pipeline.ts'
import { portAnalysis } from '../src/report.ts'
import { defaultSourceLoader } from '../src/source.ts'
import type { CheckoutFn } from '../src/source.ts'
import { ruleTriage } from '../src/triage.ts'
import type { SourceFile } from '../src/types.ts'
import { type FakeSourceMergeRequest, fakeForge } from './fakes.ts'

const available = Boolean(Bun.which('git'))

const identity = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const runner: CommandRunner = {
  run: (command, options) =>
    localRunner.run(command, { ...options, env: { ...options.env, ...identity } }),
}

const before = [
  "import { check } from './check.ts'",
  '',
  'export function login(user: string, password: string) {',
  "  if (!user) throw new Error('missing user')",
  '  return check(user, password)',
  '}',
  '',
  'export function logout(session: string) {',
  '  return session.length > 0',
  '}',
  '',
].join('\n')
const after = before.replace(
  "  if (!user) throw new Error('missing user')\n",
  "  if (!user) throw new Error('missing user')\n  if (!password) throw new Error('missing password')\n",
)
const conflicting = before.replace(
  "new Error('missing user')",
  "new LoginError('user is required')",
)

let root = ''
let sourceFiles: SourceFile[] = []
let mr: FakeSourceMergeRequest
const templates: Record<string, string> = {}

async function sh(cwd: string, ...command: string[]) {
  const result = await runner.run(command, { cwd })
  if (result.exitCode !== 0)
    throw new Error(`${command.join(' ')}: ${result.stderr || result.stdout}`)
  return result.stdout
}

async function repo(name: string, files: Record<string, string>) {
  const dir = join(root, 'templates', name.replaceAll('/', '_'))
  await mkdir(dir, { recursive: true })
  await sh(dir, 'git', 'init', '-q', '-b', 'main')
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }),
  )
  await sh(dir, 'git', 'add', '-A')
  await sh(dir, 'git', 'commit', '-qm', 'init')
  templates[name] = dir
  return dir
}

const checkout: CheckoutFn = async (ref: RepoRef) => {
  const template = templates[ref.path]
  if (!template) throw new Error(`no template for ${ref.path}`)
  const parent = await mkdtemp(join(root, 'checkout-'))
  const dir = join(parent, 'repo')
  await sh(parent, 'git', 'clone', '-q', template, dir)
  return {
    dir,
    sha: 'sha',
    ref: 'main',
    cleanup: () => rm(parent, { recursive: true, force: true }),
  }
}

/** Fails `test` while a `FAIL` file exists in the checkout. */
const verifier: Verifier = {
  async verify({ dir, attempt }) {
    const failing = await Bun.file(join(dir, 'FAIL')).exists()
    return [
      {
        name: 'test',
        command: 'test',
        exitCode: failing ? 1 : 0,
        ok: !failing,
        output: failing ? 'expected the session to be valid' : 'ok',
        durationMs: 1,
        attempt,
      },
    ]
  },
}

const noFix: Fixer = {
  fix: async () => ({
    summary: 'Could not fix.',
    changes: [],
    remainingProblems: ['still failing'],
  }),
}

function fakeAgent(): Agent & { tasks: AgentTask[] } {
  const tasks: AgentTask[] = []
  return {
    name: 'fake',
    tasks,
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      if (task.taskKind === 'port') {
        const file = join(task.dir, 'src/auth/login.ts')
        const text = await readFile(file, 'utf8')
        await writeFile(
          file,
          text.replace(
            "  if (!user) throw new LoginError('user is required')\n",
            "  if (!user) throw new LoginError('user is required')\n  if (!password) throw new LoginError('password is required')\n",
          ),
        )
        return {
          text: '',
          turns: 3,
          output: {
            status: 'ported',
            summary: 'Added the password check using LoginError.',
            changes: ['src/auth/login.ts: reject empty passwords'],
            deviations: ['uses LoginError and this repository’s message style'],
          } as Output,
        }
      }
      return { text: '', turns: 1, output: { verdict: 'apply', reason: 'needed' } as Output }
    },
  }
}

beforeAll(async () => {
  if (!available) return
  root = await mkdtemp(join(tmpdir(), 'port-it-'))
  const source = await repo('libs/core', { 'src/auth/login.ts': before, 'README.md': '# core\n' })
  await writeFile(join(source, 'src/auth/login.ts'), after)
  sourceFiles = parsePatch(await sh(source, 'git', 'diff'))
  mr = {
    repo: 'libs/core',
    id: 7,
    title: 'Require a password on login',
    description: 'Closes #12, tracked in GTW-435.',
    baseSha: 'base',
    files: sourceFiles.map((file): DiffFile => ({
      oldPath: file.oldPath,
      newPath: file.newPath,
      status: file.status,
      diff: file.diff,
    })),
    base: { 'src/auth/login.ts': before },
  }
  await repo('games/clean', { 'src/auth/login.ts': before, 'package.json': '{}\n' })
  await repo('games/moved', { 'lib/login.ts': before })
  await repo('games/conflict', { 'src/auth/login.ts': conflicting })
  await repo('games/present', { 'src/auth/login.ts': after })
  await repo('games/unrelated', { 'README.md': '# hello world\n' })
  await repo('games/broken', { 'src/auth/login.ts': before, FAIL: '1\n' })
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

const groupRepos = () => Object.keys(templates).map((path): RepoRef => ({ forge: 'work', path }))

describe.skipIf(!available)('patch application', () => {
  test('applies cleanly, with remapped paths, and reports conflicts', async () => {
    const files = (
      await defaultSourceLoader.load({
        spec: { repo: 'work:libs/core', mergeRequest: 7 },
        forge: fakeForge({ repos: [], source: mr }).forge,
        forgeId: 'work',
        runner,
      })
    ).files
    expect(files[0]?.preimage).toBe(before)

    const clean = await checkout({ forge: 'work', path: 'games/clean' })
    expect(await defaultPatchApplier.apply({ dir: clean.dir, runner, files })).toMatchObject({
      applied: true,
      method: 'clean',
    })
    expect(await readFile(join(clean.dir, 'src/auth/login.ts'), 'utf8')).toBe(after)

    const moved = await checkout({ forge: 'work', path: 'games/moved' })
    expect(await defaultPatchApplier.apply({ dir: moved.dir, runner, files })).toMatchObject({
      applied: true,
      method: 'remapped',
      remapped: [{ from: 'src/auth/login.ts', to: 'lib/login.ts' }],
    })
    expect(await readFile(join(moved.dir, 'lib/login.ts'), 'utf8')).toBe(after)

    const conflict = await checkout({ forge: 'work', path: 'games/conflict' })
    const failed = await defaultPatchApplier.apply({ dir: conflict.dir, runner, files })
    expect(failed).toMatchObject({ applied: false, conflicts: ['src/auth/login.ts'] })
    expect(await readFile(join(conflict.dir, 'src/auth/login.ts'), 'utf8')).toBe(conflicting)
    expect(await sh(conflict.dir, 'git', 'status', '--porcelain')).toBe('')
  })

  test('triage finds present and inapplicable changes', async () => {
    const present = await checkout({ forge: 'work', path: 'games/present' })
    expect(
      await ruleTriage.triage({ dir: present.dir, runner, files: sourceFiles, intent: '' }),
    ).toMatchObject({
      verdict: 'already-present',
      by: 'rules',
    })
    const unrelated = await checkout({ forge: 'work', path: 'games/unrelated' })
    expect(
      await ruleTriage.triage({ dir: unrelated.dir, runner, files: sourceFiles, intent: '' }),
    ).toMatchObject({
      verdict: 'not-applicable',
    })
    const clean = await checkout({ forge: 'work', path: 'games/clean' })
    expect(
      (await ruleTriage.triage({ dir: clean.dir, runner, files: sourceFiles, intent: '' })).verdict,
    ).toBe('apply')
  })
})

describe.skipIf(!available)('runPort', () => {
  test('ports a merge request to every sibling, publishes and comments on the source', async () => {
    const fake = fakeForge({ repos: Object.keys(templates), source: mr })
    const agent = fakeAgent()
    const data = await runPort({
      group: 'games',
      forgeId: 'work',
      repos: groupRepos(),
      forge: fake.forge,
      checkout,
      runner,
      agent,
      source: { repo: 'work:libs/core', mergeRequest: 7 },
      fix: { maxAttempts: 1 },
      steps: { verifier, fixer: noFix },
    })
    const byRepo = Object.fromEntries(data.targets.map((target) => [target.repo, target]))
    expect(Object.keys(byRepo)).not.toContain('libs/core')
    expect(byRepo['games/clean']?.outcome).toBe('ported-clean')
    expect(byRepo['games/moved']?.outcome).toBe('ported-remapped')
    expect(byRepo['games/conflict']).toMatchObject({
      outcome: 'ported-adapted',
      method: 'adapted',
      adapt: { deviations: ['uses LoginError and this repository’s message style'] },
      diffStat: { files: 1, additions: 1, deletions: 0 },
    })
    expect(byRepo['games/present']?.outcome).toBe('already-present')
    expect(byRepo['games/unrelated']?.outcome).toBe('not-applicable')
    expect(byRepo['games/broken']).toMatchObject({ outcome: 'failed', method: 'clean' })
    expect(agent.tasks.find((task) => task.taskKind === 'port')?.prompt).toContain('LoginError')

    expect(data.branch).toBe('holtkeeper/port/core-mr-7')
    expect(fake.mergeRequests.map((request) => request.repo).toSorted()).toEqual([
      'games/broken',
      'games/clean',
      'games/conflict',
      'games/moved',
    ])
    const clean = fake.mergeRequests.find((request) => request.repo === 'games/clean')!
    expect(clean).toMatchObject({
      title: 'Port: Require a password on login',
      sourceBranch: 'holtkeeper/port/core-mr-7',
      labels: ['holtkeeper', 'port'],
      draft: false,
    })
    expect(clean.description).toContain('https://git.test/libs/core/-/merge_requests/7')
    expect(clean.description).toContain('#12')
    const broken = fake.mergeRequests.find((request) => request.repo === 'games/broken')!
    expect(broken).toMatchObject({ draft: true, labels: ['holtkeeper', 'port', 'needs-attention'] })
    const moved = fake.commits.find((commit) => commit.repo === 'games/moved')!
    expect(moved.changes).toEqual([{ action: 'update', path: 'lib/login.ts', content: after }])

    expect(fake.comments).toHaveLength(1)
    expect(fake.comments[0]).toMatchObject({ repo: 'libs/core', id: 7 })
    expect(fake.comments[0]?.body).toContain(
      '| `games/clean` | Ported (applied cleanly) | [!1](https://git.test/games/clean/-/merge_requests/1) |',
    )
    expect(data.sourceComment).toEqual({ posted: true })

    const report = portAnalysis.toReport({
      id: '1',
      repo: { forge: 'work', path: 'games' },
      kind: 'port',
      createdAt: '2026-10-30T00:00:00.000Z',
      data: portAnalysis.schema.parse(data),
    })
    expect(report.sections.map((section) => section.id)).toEqual([
      'overview',
      'adaptations',
      'skipped',
      'failures',
      'source',
    ])
  })

  test('without an agent, conflicts fail; dry runs publish nothing; targets narrow by group name', async () => {
    const fake = fakeForge({ repos: Object.keys(templates), source: mr })
    const data = await runPort({
      group: 'all',
      forgeId: 'work',
      repos: groupRepos(),
      forge: fake.forge,
      checkout,
      runner,
      source: { repo: 'libs/core', mergeRequest: 7 },
      targets: ['games'],
      dryRun: true,
      steps: { verifier },
    })
    const conflict = data.targets.find((target) => target.repo === 'games/conflict')
    expect(conflict).toMatchObject({ outcome: 'failed' })
    expect(conflict?.reason).toContain('no agent')
    expect(data.targets.find((target) => target.repo === 'games/broken')?.outcome).toBe('failed')
    expect(data.targets).toHaveLength(6)
    expect(fake.commits).toHaveLength(0)
    expect(fake.comments).toHaveLength(0)
  })

  test('a failing source comment is recorded, not thrown', async () => {
    const fake = fakeForge({ repos: Object.keys(templates), source: mr, failComment: true })
    const data = await runPort({
      group: 'games',
      forgeId: 'work',
      repos: groupRepos(),
      forge: fake.forge,
      checkout,
      runner,
      source: { repo: 'libs/core', mergeRequest: 7 },
      targets: ['games/clean'],
      steps: { verifier },
    })
    expect(data.targets.map((target) => target.outcome)).toEqual(['ported-clean'])
    expect(data.sourceComment).toEqual({ posted: false, error: '403 forbidden' })
  })

  test('loads commits from a source checkout', async () => {
    const source = templates['libs/core']!
    await sh(source, 'git', 'commit', '-qam', 'Require a password (GTW-435)')
    const sha = (await sh(source, 'git', 'rev-parse', 'HEAD')).trim()
    const change = await defaultSourceLoader.load({
      spec: { repo: 'work:libs/core', commits: [sha] },
      forge: fakeForge({ repos: ['libs/core'] }).forge,
      forgeId: 'work',
      checkout,
      runner,
    })
    expect(change).toMatchObject({
      kind: 'commits',
      title: 'Require a password (GTW-435)',
      issues: ['GTW-435'],
    })
    expect(change.files).toHaveLength(1)
    expect(change.files[0]).toMatchObject({
      newPath: 'src/auth/login.ts',
      status: 'modified',
      preimage: before,
    })
  })
})
