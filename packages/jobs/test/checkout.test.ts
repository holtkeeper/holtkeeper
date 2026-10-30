import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { defineAnalyzer } from '@holtkeeper/analyzer'
import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import { parseConfig } from '@holtkeeper/core'
import { localRunner, runChecked } from '@holtkeeper/exec'
import type { GitForge } from '@holtkeeper/forge'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { createContextFactory, createJobEngine } from '../src/index.ts'

const isolated = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

const readme = defineAnalyzer({
  kind: 'readme',
  analysis: { kind: 'readme' } as AnyAnalyzer['analysis'],
  scope: 'repo',
  needs: { checkout: true },
  options: z.object({}),
  async run({ dir, ref }) {
    if (!dir) throw new Error('no checkout')
    return {
      data: { text: await Bun.file(join(dir, 'README.md')).text() },
      ...(ref ? { ref } : {}),
    }
  },
})

const combined = defineAnalyzer({
  kind: 'combined',
  analysis: { kind: 'combined' } as AnyAnalyzer['analysis'],
  scope: 'repo',
  needs: { checkout: true },
  options: z.object({ shared: z.string().default('work:platform/shared') }),
  requiredCheckouts: (options) => [{ repo: options.shared, ref: 'v1.0.0' }],
  async run({ dir, checkouts, options }) {
    const shared = checkouts?.[options.shared]
    if (!dir || !shared) throw new Error('missing checkouts')
    return {
      data: {
        own: await Bun.file(join(dir, 'README.md')).text(),
        shared: await Bun.file(join(shared, 'README.md')).text(),
      },
    }
  },
})

const fleet = defineAnalyzer({
  kind: 'fleet-readmes',
  analysis: { kind: 'fleet-readmes' } as AnyAnalyzer['analysis'],
  scope: 'group',
  needs: {},
  options: z.object({}),
  async run({ repos, checkout }) {
    if (!repos || !checkout) throw new Error('missing group context')
    const texts: Record<string, string> = {}
    for (const repo of repos) {
      const copy = await checkout(repo, { writable: true })
      await Bun.write(join(copy.dir, 'README.md'), 'changed\n')
      texts[repo.path] = copy.ref
    }
    return { data: texts }
  },
})

describe.skipIf(!Bun.which('git'))('job engine with a real checkout', () => {
  let root: string
  const saved: Record<string, string | undefined> = {}

  beforeAll(async () => {
    for (const [key, value] of Object.entries(isolated)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
    root = await mkdtemp(join(tmpdir(), 'holtkeeper-jobs-'))
    const origin = join(root, 'origin')
    const git = (...args: string[]) =>
      runChecked(localRunner, ['git', ...args], { cwd: origin, env: isolated })
    await Bun.write(join(origin, 'README.md'), 'v1\n')
    await git('init', '-q', '-b', 'main')
    await git('add', '.')
    await git('commit', '-q', '-m', 'first')
    await git('tag', 'v1.0.0')
    await Bun.write(join(origin, 'README.md'), 'v2\n')
    await git('commit', '-q', '-am', 'second')
  })

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })

  test('runs queued jobs against fresh checkouts of the right ref', async () => {
    const forge = {
      kind: 'fake',
      getRepository: async (path: string) => ({
        path,
        name: 'origin',
        defaultBranch: 'main',
        webUrl: '',
        cloneUrl: pathToFileURL(join(root, 'origin')).href,
        archived: false,
      }),
    } as unknown as GitForge
    const config = parseConfig({
      forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => forge } },
      jobs: { cacheDir: join(root, 'cache') },
    })
    const store = memoryStore()
    const engine = createJobEngine({ config, store, analyzers: [readme] })
    const repo = { forge: 'work', path: 'games/a' }
    const createdAt = new Date().toISOString()
    await store.jobs.enqueue({ analyzer: 'readme', repo, trigger: 'manual', createdAt })
    await store.jobs.enqueue({ analyzer: 'readme', repo, ref: 'v1.0.0', trigger: 'tag', createdAt })

    const head = await engine.worker.runNext()
    const tagged = await engine.worker.runNext()
    expect(head?.status).toBe('succeeded')
    expect(tagged?.status).toBe('succeeded')
    const records = await store.analyses.list({ kind: 'readme' })
    expect(records.map((r) => `${r.ref ?? '-'} ${JSON.stringify(r.data)}`).toSorted()).toEqual([
      `- ${JSON.stringify({ text: 'v2\n' })}`,
      `v1.0.0 ${JSON.stringify({ text: 'v1\n' })}`,
    ])
    expect(tagged?.log.some((line) => line.startsWith('checked out v1.0.0'))).toBeTrue()
    expect((await readdir(join(root, 'cache'))).length).toBe(1)
    await engine.stop()
  })

  test('group analyzers check out repositories on demand and the worker cleans up', async () => {
    const forge = {
      kind: 'fake',
      getRepository: async (path: string) => ({
        path,
        name: path,
        defaultBranch: 'main',
        webUrl: '',
        cloneUrl: pathToFileURL(join(root, 'origin')).href,
        archived: false,
      }),
    } as unknown as GitForge
    const config = parseConfig({
      forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => forge } },
      groups: { games: { forge: 'work', include: ['games/*'] } },
      jobs: { cacheDir: join(root, 'cache-group') },
    })
    const store = memoryStore()
    const workDir = join(root, 'work-group')
    await mkdir(workDir, { recursive: true })
    const engine = createJobEngine({
      config,
      store,
      analyzers: [fleet],
      resolveRepos: async () => [
        { forge: 'work', path: 'games/a' },
        { forge: 'work', path: 'games/b' },
      ],
      contextFor: createContextFactory({
        config,
        store,
        cacheDir: join(root, 'cache-group'),
        workDir,
        resolveRepos: async () => [
          { forge: 'work', path: 'games/a' },
          { forge: 'work', path: 'games/b' },
        ],
      }),
    })
    await store.jobs.enqueue({
      analyzer: 'fleet-readmes',
      repo: { forge: 'work', path: 'games' },
      group: 'games',
      trigger: 'manual',
      createdAt: new Date().toISOString(),
    })
    expect((await engine.worker.runNext())?.status).toBe('succeeded')
    const [record] = await store.analyses.list({ kind: 'fleet-readmes' })
    expect(record?.data).toEqual({ 'games/a': 'main', 'games/b': 'main' })
    expect(await readdir(workDir)).toEqual([])
  })

  test('passes extra checkouts of other repositories', async () => {
    const forge = {
      kind: 'fake',
      getRepository: async (path: string) => ({
        path,
        name: path,
        defaultBranch: 'main',
        webUrl: '',
        cloneUrl: pathToFileURL(join(root, 'origin')).href,
        archived: false,
      }),
    } as unknown as GitForge
    const config = parseConfig({
      forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => forge } },
      jobs: { cacheDir: join(root, 'cache-extra') },
    })
    const store = memoryStore()
    const engine = createJobEngine({ config, store, analyzers: [combined] })
    await store.jobs.enqueue({
      analyzer: 'combined',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      createdAt: new Date().toISOString(),
    })
    const job = await engine.worker.runNext()
    expect(job?.status).toBe('succeeded')
    const [record] = await store.analyses.list({ kind: 'combined' })
    expect(record?.data).toEqual({ own: 'v2\n', shared: 'v1\n' })
  })
})
