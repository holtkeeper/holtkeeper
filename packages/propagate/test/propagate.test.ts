import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CommandRunner, localRunner } from '@holtkeeper/exec'

import { propagateLocal, runPropagation } from '../src/pipeline.ts'
import { propagationAnalysis } from '../src/report.ts'
import type { FixProposer, FixRequest, PropagationData } from '../src/types.ts'
import { fakeForge } from './fakes.ts'

const tsc = join(import.meta.dir, '../../../node_modules/.bin/tsc')
const available = Boolean(Bun.which('git') && Bun.which('tar')) && (await Bun.file(tsc).exists())

let root = ''
let template = ''
let server: ReturnType<typeof Bun.serve> | undefined
let runner: CommandRunner = localRunner

const libraries = {
  '1.0.0': {
    'index.js': 'export const greet = (name) => `hello ${name}`\n',
    'index.d.ts': 'export declare function greet(name: string): string\n',
    'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- first release\n',
  },
  '2.0.0': {
    'index.js': 'export const greet = ({ name }) => `hello ${name}`\n',
    'index.d.ts': 'export declare function greet(options: { name: string }): string\n',
    'CHANGELOG.md':
      '# Changelog\n\n## 2.0.0\n\n- BREAKING: `greet` takes `{ name }` instead of a string\n\n## 1.0.0\n\n- first release\n',
  },
}

async function sh(cwd: string, ...command: string[]) {
  const result = await runner.run(command, { cwd })
  if (result.exitCode !== 0)
    throw new Error(`${command.join(' ')}: ${result.stderr || result.stdout}`)
  return result.stdout
}

beforeAll(async () => {
  if (!available) return
  root = await mkdtemp(join(tmpdir(), 'propagate-it-'))
  const tarballs: Record<string, { bytes: Uint8Array; integrity: string }> = {}
  for (const [version, files] of Object.entries(libraries)) {
    const dir = join(root, `lib-${version}`, 'package')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'acme-lib',
        version,
        type: 'module',
        main: 'index.js',
        types: 'index.d.ts',
      }),
    )
    for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content)
    const tarball = join(root, `acme-lib-${version}.tgz`)
    await sh(root, 'tar', '-czf', tarball, '-C', join(root, `lib-${version}`), 'package')
    const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer())
    tarballs[version] = {
      bytes,
      integrity: `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`,
    }
  }
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const { pathname } = new URL(request.url)
      const base = `http://127.0.0.1:${server?.port}`
      if (pathname === '/acme-lib')
        return Response.json({
          name: 'acme-lib',
          'dist-tags': { latest: '2.0.0' },
          versions: Object.fromEntries(
            Object.entries(tarballs).map(([version, { integrity }]) => [
              version,
              {
                name: 'acme-lib',
                version,
                dist: { tarball: `${base}/acme-lib/-/acme-lib-${version}.tgz`, integrity },
              },
            ]),
          ),
        })
      const match = /^\/acme-lib\/-\/acme-lib-(.+)\.tgz$/.exec(pathname)
      const tarball = match ? tarballs[match[1]!] : undefined
      return tarball ? new Response(tarball.bytes) : new Response('not found', { status: 404 })
    },
  })
  const registry = `http://127.0.0.1:${server.port}/`
  const env = {
    BUN_CONFIG_REGISTRY: registry,
    BUN_INSTALL_CACHE_DIR: join(root, 'cache'),
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  runner = {
    run: (command, options) =>
      localRunner.run(command, { ...options, env: { ...options.env, ...env } }),
  }

  template = join(root, 'template')
  await mkdir(join(template, 'src'), { recursive: true })
  await writeFile(
    join(template, 'package.json'),
    `${JSON.stringify(
      {
        name: 'app',
        private: true,
        type: 'module',
        dependencies: { 'acme-lib': '^1.0.0' },
        scripts: { typecheck: `${tsc} --noEmit -p .` },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(template, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'preserve',
        moduleResolution: 'bundler',
        types: [],
        target: 'esnext',
      },
      include: ['src'],
    }),
  )
  await writeFile(
    join(template, 'src/index.ts'),
    "import { greet } from 'acme-lib'\n\nexport const message = greet('world')\n",
  )
  await writeFile(join(template, 'bunfig.toml'), `[install]\nregistry = "${registry}"\n`)
  await writeFile(join(template, '.gitignore'), 'node_modules\n')
  await sh(template, 'bun', 'install', '--ignore-scripts')
  await sh(template, 'git', 'init', '-q', '-b', 'main')
  await sh(template, 'git', 'add', '-A')
  await sh(template, 'git', 'commit', '-q', '-m', 'init')
}, 60_000)

afterAll(async () => {
  await server?.stop(true)
  if (root) await rm(root, { recursive: true, force: true })
})

async function copyProject() {
  const dir = await mkdtemp(join(root, 'work-'))
  await cp(template, dir, { recursive: true })
  return dir
}

const packages = [{ name: 'acme-lib', version: 'latest' }]
const registry = { latest: async () => '2.0.0' }

describe.skipIf(!available)('propagate on a real bun project', () => {
  test('bumps, regenerates the lockfile and reports the broken typecheck', async () => {
    const dir = await copyProject()
    const result = await propagateLocal({ dirs: [dir], packages, runner, registry })
    const outcome = result.repos[0]!
    expect(outcome.status).toBe('failed')
    expect(outcome.bumps).toEqual([
      { package: 'acme-lib', from: '^1.0.0', to: '^2.0.0', manifest: 'package.json' },
    ])
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toContain('"acme-lib": "^2.0.0"')
    expect(await readFile(join(dir, 'bun.lock'), 'utf8')).toContain('acme-lib@2.0.0')
    expect(outcome.checks.map((check) => [check.name, check.ok])).toEqual([
      ['install', true],
      ['typecheck', false],
    ])
    expect(outcome.checks[1]!.output).toContain('src/index.ts')
    expect(outcome.changedFiles.toSorted()).toEqual(['bun.lock', 'package.json'])
  }, 60_000)

  test('proposes a fix task with the bump as a patch and publishes nothing for it', async () => {
    const manifest = await readFile(join(template, 'package.json'), 'utf8')
    const { forge, commits, mergeRequests } = fakeForge({
      'games/a': { 'package.json': manifest },
      'games/b': { 'package.json': '{"dependencies":{"acme-lib":"^2.0.0"}}' },
      'games/c': { 'package.json': '{"dependencies":{"left-pad":"1.0.0"}}' },
      'other/d': {},
    })
    const cleaned: string[] = []
    const proposals: { group: string; title: string; fixes: FixRequest[] }[] = []
    const fixes: FixProposer = {
      async propose(input) {
        proposals.push(input)
        return { groupId: 'gabc1234', tasks: { 'work:games/a': 'tabc1234' } }
      },
    }
    const data: PropagationData = await runPropagation({
      group: 'games',
      forgeId: 'work',
      repos: ['games/a', 'games/b', 'games/c', 'other/d'].map((path) => ({ forge: 'work', path })),
      onlyRepos: ['games/*'],
      forge,
      async checkout(repo, options) {
        expect(options).toEqual({ ref: 'main', writable: true })
        const dir = await copyProject()
        return { dir, sha: 'abc', ref: 'main', cleanup: async () => void cleaned.push(repo.path) }
      },
      runner,
      registry,
      packages,
      fixes,
    })
    expect(data.repos.map((repo) => [repo.repo, repo.status, repo.fixTask])).toEqual([
      ['games/a', 'failed', 'tabc1234'],
      ['games/b', 'unchanged', undefined],
      ['games/c', 'skipped', undefined],
    ])
    expect(data.fixGroup).toBe('gabc1234')
    expect(cleaned).toEqual(['games/a'])
    expect(commits).toEqual([])
    expect(mergeRequests).toEqual([])

    expect(proposals).toHaveLength(1)
    const [proposal] = proposals
    expect(proposal!.group).toBe('games')
    expect(proposal!.title).toBe('chore(deps): update acme-lib to 2.0.0')
    const fix = proposal!.fixes[0]!
    expect(fix.repo).toBe('work:games/a')
    expect(fix.prompt).toContain('Never edit lockfiles')
    expect(fix.prompt).toContain('- acme-lib: ^1.0.0 → ^2.0.0 (package.json)')
    expect(fix.prompt).toContain('### typecheck')
    expect(fix.prompt).toContain('`greet` takes `{ name }` instead of a string')

    const fresh = await copyProject()
    await writeFile(join(fresh, 'bump.patch'), fix.patch)
    await sh(fresh, 'git', 'update-index', '-q', '--refresh')
    await sh(fresh, 'git', 'apply', '-3', 'bump.patch')
    expect(await readFile(join(fresh, 'package.json'), 'utf8')).toContain('"acme-lib": "^2.0.0"')
    expect(await readFile(join(fresh, 'bun.lock'), 'utf8')).toContain('acme-lib@2.0.0')

    expect(data.releaseNotes[0]).toMatchObject({
      package: 'acme-lib',
      from: '1.0.0',
      to: '2.0.0',
      source: 'node_modules/acme-lib',
    })
    const report = propagationAnalysis.toReport({
      id: '1',
      repo: { forge: 'work', path: 'games' },
      kind: 'propagation',
      createdAt: '2026-10-30T00:00:00.000Z',
      data,
    })
    expect(report.sections.map((section) => section.id)).toEqual([
      'overview',
      'failures',
      'release-notes',
      'plan',
    ])
    expect(propagationAnalysis.schema.parse(data)).toEqual(data)
  }, 90_000)

  test('opens the draft from the bump patch when no fix task is proposed', async () => {
    const manifest = await readFile(join(template, 'package.json'), 'utf8')
    const { forge, commits, mergeRequests } = fakeForge({ 'games/a': { 'package.json': manifest } })
    let checkouts = 0
    const data = await runPropagation({
      group: 'games',
      forgeId: 'work',
      repos: [{ forge: 'work', path: 'games/a' }],
      forge,
      checkout: async () => {
        checkouts++
        return { dir: await copyProject(), sha: 'abc', ref: 'main', cleanup: async () => {} }
      },
      runner,
      registry,
      packages,
      fixes: { propose: async () => undefined },
    })
    expect(checkouts).toBe(2)
    expect(data.repos[0]).toMatchObject({ status: 'failed', mergeRequest: { draft: true } })
    expect(data.repos[0]!.notes).toContain('no fix task was proposed')
    expect(commits[0]!.changes.map((change) => change.path).toSorted()).toEqual([
      'bun.lock',
      'package.json',
    ])
    expect(mergeRequests[0]!.labels).toContain('needs-attention')
  }, 90_000)

  test('opens a draft labeled needs-attention without a fix proposer', async () => {
    const manifest = await readFile(join(template, 'package.json'), 'utf8')
    const { forge, commits, mergeRequests } = fakeForge({ 'games/a': { 'package.json': manifest } })
    const data = await runPropagation({
      group: 'games',
      forgeId: 'work',
      repos: [{ forge: 'work', path: 'games/a' }],
      forge,
      checkout: async () => ({
        dir: await copyProject(),
        sha: 'abc',
        ref: 'main',
        cleanup: async () => {},
      }),
      runner,
      registry,
      packages,
    })
    expect(data.repos[0]!.status).toBe('failed')
    expect(data.fixGroup).toBeUndefined()
    expect(commits).toHaveLength(1)
    const commit = commits[0]!
    expect(commit.branch).toBe('holtkeeper/update/acme-lib-2.0.0')
    expect(commit.startBranch).toBe('main')
    expect(commit.changes.map((change) => `${change.action} ${change.path}`).toSorted()).toEqual([
      'update bun.lock',
      'update package.json',
    ])
    const mr = mergeRequests[0]!
    expect(mr.draft).toBe(true)
    expect(mr.labels).toEqual(['holtkeeper', 'dependencies', 'needs-attention'])
    expect(mr.title).toBe('chore(deps): update acme-lib to 2.0.0')
    expect(mr.description).toContain('| `acme-lib` | `^1.0.0` | `^2.0.0` | `package.json` |')
    expect(mr.description).toContain('## Needs attention')
    expect(data.repos[0]!.mergeRequest).toEqual({ id: 1, url: mr.webUrl, draft: true })
  }, 90_000)
})
