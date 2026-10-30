import { describe, expect, test } from 'bun:test'

import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import { parseConfig } from '@holtkeeper/core'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { GitForge } from '@holtkeeper/forge'
import type { Job } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import type { CheckoutOptions } from '@holtkeeper/workspace'
import { z } from 'zod'

import { type ForgeGitKey, createContextFactory } from './context.ts'

const forge = {
  kind: 'fake',
  getRepository: async (path: string) => ({
    path,
    name: 'a',
    defaultBranch: 'trunk',
    webUrl: '',
    cloneUrl: `https://forge.test/${path}.git`,
    archived: false,
  }),
} as unknown as GitForge

const config = parseConfig({
  forges: {
    work: {
      kind: 'fake',
      url: 'https://forge.test',
      create: () => forge,
      gitCredentials: () => ({ username: 'oauth2', password: 'tok' }),
    },
  },
  groups: { games: { forge: 'work', include: ['games/*'] } },
})

const analyzer = (needs: AnyAnalyzer['needs'], scope: 'repo' | 'group' = 'repo'): AnyAnalyzer => ({
  kind: 'x',
  analysis: { kind: 'x' } as AnyAnalyzer['analysis'],
  scope,
  needs,
  options: z.object({}),
  run: async () => ({ data: {} }),
})

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'j1',
  analyzer: 'x',
  repo: { forge: 'work', path: 'games/a' },
  options: {},
  trigger: 'manual',
  status: 'running',
  attempts: 1,
  maxAttempts: 3,
  runAfter: 'now',
  createdAt: 'now',
  log: [],
  ...overrides,
})

const io = { signal: new AbortController().signal, log: () => {}, options: {} }

describe('createContextFactory', () => {
  const checkouts: CheckoutOptions[] = []
  let cleaned = 0
  const store = memoryStore()
  const agent = { name: 'agent' } as never
  const contextFor = createContextFactory({
    config,
    store,
    cacheDir: '/cache',
    runner: createFakeRunner().runner,
    agentFor: (repo) => (repo.path === 'games/a' ? agent : undefined),
    resolveRepos: async () => [{ forge: 'work', path: 'games/a' }],
    checkout: async (options) => {
      checkouts.push(options)
      return {
        dir: '/tmp/co',
        sha: 'abc',
        ref: options.ref ?? '',
        cleanup: async () => void cleaned++,
      }
    },
  })

  test('provides only what the analyzer needs', async () => {
    const { context } = await contextFor(job(), analyzer({}), io)
    expect(Object.keys(context).toSorted()).toEqual(['checkout', 'repo', 'runner'])
  })

  test('checks out the default branch with forge credentials and cleans up', async () => {
    const prepared = await contextFor(
      job(),
      analyzer({ checkout: true, forge: true, history: true, agent: 'optional' }),
      io,
    )
    expect(prepared.context).toMatchObject({
      dir: '/tmp/co',
      forge,
      agent,
      history: { analyses: store.analyses },
    })
    expect(checkouts.at(-1)).toMatchObject({
      cloneUrl: 'https://forge.test/games/a.git',
      ref: 'trunk',
      credentials: { username: 'oauth2', password: 'tok' },
      cacheDir: '/cache',
    })
    await prepared.cleanup()
    expect(cleaned).toBe(1)
  })

  test('uses the job ref and passes it on', async () => {
    const prepared = await contextFor(job({ ref: 'v1.2.0' }), analyzer({ checkout: true }), io)
    expect(checkouts.at(-1)?.ref).toBe('v1.2.0')
    expect(prepared.context.ref).toBe('v1.2.0')
  })

  test('group analyzers get the group repositories and no checkout', async () => {
    const before = checkouts.length
    const { context } = await contextFor(
      job({ repo: { forge: 'work', path: 'games' }, group: 'games' }),
      analyzer({ checkout: true }, 'group'),
      io,
    )
    expect(context.repos).toEqual([{ forge: 'work', path: 'games/a' }])
    expect(checkouts).toHaveLength(before)
  })

  test('checks out required extra repositories and cleans them up with the rest', async () => {
    const withExtras: AnyAnalyzer = {
      ...analyzer({ checkout: true }),
      requiredCheckouts: (options: { shared: string }, repo) => [
        { repo: options.shared, ref: 'v3' },
        { repo: { forge: 'work', path: `${repo.path}-docs` } },
        { repo: options.shared },
      ],
    }
    const before = checkouts.length
    const cleanedBefore = cleaned
    const prepared = await contextFor(job(), withExtras, {
      ...io,
      options: { shared: 'work:platform/config' },
    })
    expect(checkouts.slice(before).map((c) => [c.cloneUrl, c.ref])).toEqual([
      ['https://forge.test/games/a.git', 'trunk'],
      ['https://forge.test/platform/config.git', 'v3'],
      ['https://forge.test/games/a-docs.git', 'trunk'],
    ])
    expect(Object.keys(prepared.context.checkouts ?? {})).toEqual([
      'work:platform/config',
      'work:games/a-docs',
    ])
    await prepared.cleanup()
    expect(cleaned - cleanedBefore).toBe(3)
    expect(
      contextFor(job(), { ...withExtras, requiredCheckouts: () => [{ repo: 'bad' }] }, io),
    ).rejects.toThrow('expected forge:path')
  })

  test('group analyzers check out repositories on demand; leftovers go with cleanup', async () => {
    const cleanedBefore = cleaned
    const prepared = await contextFor(
      job({ repo: { forge: 'work', path: 'games' }, group: 'games' }),
      analyzer({}, 'group'),
      io,
    )
    const checkoutRepo = prepared.context.checkout
    if (!checkoutRepo) throw new Error('no checkout')
    const a = await checkoutRepo({ forge: 'work', path: 'games/a' }, { writable: true })
    const b = await checkoutRepo({ forge: 'work', path: 'games/b' }, { ref: 'v9' })
    expect([a.ref, b.ref]).toEqual(['trunk', 'v9'])
    expect(checkouts.at(-1)?.cloneUrl).toBe('https://forge.test/games/b.git')
    await a.cleanup()
    expect(cleaned - cleanedBefore).toBe(1)
    await prepared.cleanup()
    expect(cleaned - cleanedBefore).toBe(2)
  })

  test('rejects a required agent that is missing and unknown forges', async () => {
    expect(
      contextFor(
        job({ repo: { forge: 'work', path: 'games/b' } }),
        analyzer({ agent: 'required' }),
        io,
      ),
    ).rejects.toThrow('needs an agent')
    expect(
      contextFor(job({ repo: { forge: 'nope', path: 'a' } }), analyzer({}), io),
    ).rejects.toThrow('not configured')
  })
})

const commit = async () => ({ sha: 'def' })
const push = async () => ({ pushed: true, sha: 'def' })

const setup = (gitKey: ForgeGitKey | undefined, readOnly = false) => {
  const seen: CheckoutOptions[] = []
  const contextFor = createContextFactory({
    config,
    store: memoryStore(),
    cacheDir: '/cache',
    runner: createFakeRunner().runner,
    gitKeyFor: async (forgeId) => (forgeId === 'work' ? gitKey : undefined),
    readOnly: async () => readOnly,
    checkout: async (options) => {
      seen.push(options)
      return { dir: '/tmp/co', sha: 'abc', ref: 'trunk', cleanup: async () => {}, commit, push }
    },
  })
  const open = async () => {
    const prepared = await contextFor(job(), analyzer({}), io)
    const checkout = await prepared.context.checkout?.({ forge: 'work', path: 'games/a' })
    return { checkout, options: seen.at(-1) }
  }
  return { open }
}

describe('forge SSH keys in checkouts', () => {
  const key: ForgeGitKey = {
    privateKey: 'PRIVATE',
    publicKey: 'ssh-ed25519 AAAA bot',
    usage: 'auth_and_signing',
    knownHosts: 'forge.test ssh-ed25519 AAAA\n',
    identity: { name: 'Bot', email: 'bot@forge.test' },
  }

  test('clones over SSH and signs with the key; offers a publisher', async () => {
    const { open } = setup(key)
    const { checkout, options } = await open()
    expect(options).toMatchObject({
      ssh: { privateKey: 'PRIVATE', knownHosts: key.knownHosts },
      signing: {
        privateKey: 'PRIVATE',
        publicKey: key.publicKey,
        name: 'Bot',
        email: 'bot@forge.test',
      },
      credentials: { username: 'oauth2', password: 'tok' },
    })
    expect(checkout?.publisher).toEqual({ commit, push })
  })

  test('offers no publisher for read-only repositories', async () => {
    const { checkout, options } = await setup(key, true).open()
    expect(options?.signing).toBeDefined()
    expect(checkout?.publisher).toBeUndefined()
  })

  test('without host keys git stays on HTTPS; without identity nothing is signed', async () => {
    const { knownHosts: _hosts, ...unpinned } = key
    const first = await setup(unpinned).open()
    expect(first.options?.ssh).toBeUndefined()
    expect(first.options?.signing).toBeDefined()

    const { identity: _identity, ...anonymous } = key
    const second = await setup({ ...anonymous, usage: 'auth' }).open()
    expect(second.options?.ssh).toBeDefined()
    expect(second.options?.signing).toBeUndefined()
    expect(second.checkout?.publisher).toBeUndefined()

    const none = await setup(undefined).open()
    expect(none.options).not.toHaveProperty('ssh')
    expect(none.options).not.toHaveProperty('signing')
  })
})
