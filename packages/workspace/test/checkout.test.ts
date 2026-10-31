import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { localRunner, runChecked } from '@holtkeeper/exec'

import { checkout } from '../src/index.ts'

const isolated = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

const git = (cwd: string, ...args: string[]) =>
  runChecked(localRunner, ['git', ...args], { cwd, env: isolated })

describe.skipIf(!Bun.which('git'))('checkout with real git', () => {
  let root: string
  let origin: string
  let cloneUrl: string
  const saved: Record<string, string | undefined> = {}

  const commit = async (file: string, content: string) => {
    await Bun.write(join(origin, file), content)
    await git(origin, 'add', '.')
    await git(origin, 'commit', '-q', '-m', `add ${file}`)
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(isolated)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
    root = await mkdtemp(join(tmpdir(), 'holtkeeper-ws-'))
    origin = join(root, 'origin')
    await Bun.write(join(origin, '.keep'), '')
    await git(origin, 'init', '-q', '-b', 'trunk')
    await commit('a.txt', 'one\n')
    await git(origin, 'tag', 'v1.0.0')
    await commit('a.txt', 'two\n')
    cloneUrl = pathToFileURL(origin).href
  })

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })

  test('checks out the default branch, then a tag, reusing the mirror', async () => {
    const cacheDir = join(root, 'cache')
    const head = await checkout({ cloneUrl, cacheDir, runner: localRunner, workDir: root })
    expect(head.ref).toBe('trunk')
    expect(await Bun.file(join(head.dir, 'a.txt')).text()).toBe('two\n')
    expect(head.sha).toBe((await git(origin, 'rev-parse', 'HEAD')).stdout.trim())

    const lines: string[] = []
    const tagged = await checkout({
      cloneUrl,
      ref: 'v1.0.0',
      cacheDir,
      runner: localRunner,
      workDir: root,
      log: (line) => lines.push(line),
    })
    expect(await Bun.file(join(tagged.dir, 'a.txt')).text()).toBe('one\n')
    expect(lines[0]).toStartWith('fetching')
    expect((await git(tagged.dir, 'tag', '--list')).stdout.trim()).toBe('v1.0.0')
    expect(await readdir(cacheDir)).toHaveLength(1)

    await head.cleanup()
    await head.cleanup()
    expect(await Bun.file(join(head.dir, 'a.txt')).exists()).toBeFalse()
    await tagged.cleanup()
    const mirror = join(cacheDir, (await readdir(cacheDir))[0] ?? '')
    expect((await git(mirror, 'worktree', 'list')).stdout.trim().split('\n')).toHaveLength(1)
  })

  test('sees commits and tags pushed after the mirror was made', async () => {
    const cacheDir = join(root, 'cache-new')
    await (await checkout({ cloneUrl, cacheDir, runner: localRunner, workDir: root })).cleanup()
    await commit('b.txt', 'new\n')
    await git(origin, 'tag', 'v2.0.0')

    const latest = await checkout({
      cloneUrl,
      ref: 'v2.0.0',
      cacheDir,
      runner: localRunner,
      workDir: root,
    })
    expect(await Bun.file(join(latest.dir, 'b.txt')).text()).toBe('new\n')
    await latest.cleanup()
  })

  test('concurrent checkouts of one repository both succeed', async () => {
    const cacheDir = join(root, 'cache-parallel')
    const [a, b] = await Promise.all([
      checkout({ cloneUrl, cacheDir, runner: localRunner, workDir: root }),
      checkout({ cloneUrl, ref: 'v1.0.0', cacheDir, runner: localRunner, workDir: root }),
    ])
    expect(a.dir).not.toBe(b.dir)
    await Promise.all([a.cleanup(), b.cleanup()])
  })

  test('keeps worktrees another host made in a shared cache, drops abandoned ones', async () => {
    const cacheDir = join(root, 'cache-shared')
    const elsewhere = await checkout({ cloneUrl, cacheDir, runner: localRunner, workDir: root })
    const hidden = `${elsewhere.dir}-on-another-host`
    const [mirror] = (await readdir(cacheDir)).filter((name) => name.endsWith('.git'))
    const metadata = join(cacheDir, mirror ?? '', 'worktrees')
    const [id] = await readdir(metadata)

    await rename(elsewhere.dir, hidden)
    const here = await checkout({ cloneUrl, cacheDir, runner: localRunner, workDir: root })
    expect(await readdir(metadata)).toContain(id ?? '')
    await rename(hidden, elsewhere.dir)
    expect((await git(elsewhere.dir, 'status', '--porcelain')).stdout).toBe('')

    await writeFile(
      join(metadata, id ?? '', 'locked'),
      'holtkeeper other-host 2026-01-01T00:00:00.000Z',
    )
    await rename(elsewhere.dir, hidden)
    const later = await checkout({ cloneUrl, cacheDir, runner: localRunner, workDir: root })
    const gitdirs = await Promise.all(
      (await readdir(metadata)).map((entry) => readFile(join(metadata, entry, 'gitdir'), 'utf8')),
    )
    expect(gitdirs.filter((gitdir) => gitdir.startsWith(elsewhere.dir))).toEqual([])
    expect(gitdirs).toHaveLength(2)
    await rename(hidden, elsewhere.dir)
    await Promise.all([elsewhere.cleanup(), here.cleanup(), later.cleanup()])
  })

  test('rejects unknown refs and leaves no checkout behind', async () => {
    const cacheDir = join(root, 'cache-missing')
    const outcome = await checkout({
      cloneUrl,
      ref: 'nope',
      cacheDir,
      runner: localRunner,
      workDir: root,
    }).then(
      () => 'checked out',
      () => 'rejected',
    )
    expect(outcome).toBe('rejected')
    const leftovers = (await readdir(root)).filter((name) =>
      name.startsWith('holtkeeper-checkout-'),
    )
    expect(leftovers).toEqual([])
  })
})
