import { beforeEach, describe, expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig, parseConfigFile } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { type GitForge, type RepoRef, ReadOnlyRepositoryError } from '@holtkeeper/forge'
import { createLimiter } from '@holtkeeper/limits'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import type { ServerDeps } from '../src/context.ts'
import { createEventDispatcher } from '../src/events.ts'
import { startManagedConfig } from '../src/managed.ts'
import { readOnlyRepos } from '../src/read-only.ts'

let store: Store
let comments: string[]

const fakeForge = {
  kind: 'gitlab',
  commentOnMergeRequest: async (repo: string) => {
    comments.push(repo)
  },
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fakeForge } },
  groups: {
    libs: { forge: 'work', include: ['libs/*'] },
    games: { forge: 'work', include: ['games/*'] },
  },
  jobs: { onTag: { analyzers: ['changelog'] }, onMergeRequest: { analyzers: ['review'] } },
})

const vault = aesVault('v'.repeat(32))
const credentials = () => createCredentialService({ credentials: store.credentials, vault })

const freeze = (
  scope: { groups: string[] } | { repos: string[] },
  value: { frozen?: boolean; reason?: string; until?: string } = { reason: 'Shared library' },
) =>
  store.settings.put({
    id: JSON.stringify(scope),
    key: 'repo.freeze',
    scope,
    value,
    secret: false,
    updatedAt: '2026-10-30T00:00:00.000Z',
  })

const repo = (path: string): RepoRef => ({ forge: 'work', path })

beforeEach(() => {
  store = memoryStore()
  comments = []
})

describe('repo.freeze', () => {
  test('resolves by group and repository and counts only before until', async () => {
    await freeze({ groups: ['libs'] })
    await freeze(
      { repos: ['games/a'] },
      { reason: 'Code freeze', until: '2026-11-01T00:00:00.000Z' },
    )
    let now = new Date('2026-10-31T00:00:00.000Z')
    const readOnly = readOnlyRepos(
      store,
      () => config,
      () => now,
    )
    expect(await readOnly(repo('libs/ui'))).toBe(true)
    expect(await readOnly(repo('games/a'))).toBe(true)
    expect(await readOnly(repo('games/b'))).toBe(false)
    now = new Date('2026-11-01T00:00:00.000Z')
    expect(await readOnly(repo('games/a'))).toBe(false)
    expect(await readOnly(repo('libs/ui'))).toBe(true)
  })

  test('an expired repository freeze leaves the group freeze in force', async () => {
    await freeze({ groups: ['libs'] })
    await freeze({ repos: ['libs/open'] }, { reason: 'Hotfix', until: '2026-10-01T00:00:00.000Z' })
    const readOnly = readOnlyRepos(
      store,
      () => config,
      () => new Date('2026-10-31T00:00:00.000Z'),
    )
    expect(await readOnly(repo('libs/open'))).toBe(true)
  })

  test('a repository lift keeps only that repository of a frozen group writable', async () => {
    await freeze({ groups: ['libs'] })
    await freeze(
      { repos: ['libs/open'] },
      { frozen: false, reason: 'Reviewed library', until: '2026-11-01T00:00:00.000Z' },
    )
    let now = new Date('2026-10-31T00:00:00.000Z')
    const readOnly = readOnlyRepos(
      store,
      () => config,
      () => now,
    )
    expect(await readOnly(repo('libs/open'))).toBe(false)
    expect(await readOnly(repo('libs/ui'))).toBe(true)
    now = new Date('2026-11-01T00:00:00.000Z')
    expect(await readOnly(repo('libs/open'))).toBe(true)
  })

  test('forge clients of the managed config refuse writes to read-only repositories', async () => {
    await freeze({ groups: ['libs'] })
    const service = credentials()
    const credential = await service.create({
      name: 'work',
      kind: 'gitlab',
      url: 'https://gitlab.test',
      scope: { all: true },
      secret: 'tok',
    })
    const at = '2026-10-30T00:00:00.000Z'
    await store.config?.put({
      type: 'forge',
      id: 'work',
      data: { kind: 'gitlab', url: 'https://gitlab.test', credentialId: credential.id },
      updatedAt: at,
    })
    await store.config?.put({
      type: 'group',
      id: 'libs',
      data: { forge: 'work', include: ['libs/*'], exclude: [] },
      updatedAt: at,
    })
    const managed = await startManagedConfig({
      file: parseConfigFile({}, { warn: () => {} }),
      store,
      vault,
      credentials: service,
      limiter: createLimiter(),
      pollMs: 0,
    })
    const forge = managed.source.current().forges.work?.create()
    expect(forge).toBeDefined()
    expect(
      await forge?.commentOnMergeRequest('libs/ui', 1, 'hi').then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(ReadOnlyRepositoryError)
    managed.stop()
  })

  test('events of read-only repositories are ignored, except tags and lifted repositories', async () => {
    await freeze({ groups: ['libs'] })
    const deps: ServerDeps = {
      config,
      auth: noAuth(),
      store,
      vault,
      credentials: credentials(),
      settings: builtinSettings,
      analyses: [],
      analyzers: [
        { kind: 'changelog', scope: 'repo', options: z.object({}) },
        { kind: 'review', scope: 'repo', options: z.object({ mergeRequest: z.number() }) },
      ],
      readOnly: readOnlyRepos(store, () => config),
      now: () => new Date('2026-10-30T12:00:00.000Z'),
    }
    const dispatch = createEventDispatcher(deps)
    const webhook = { actor: 'webhook:gitlab', via: 'webhook' as const }
    const note = await dispatch(
      {
        kind: 'note',
        repo: repo('libs/ui'),
        mergeRequest: 7,
        mergeRequestState: 'open',
        author: 'jane',
        body: '/holtkeeper review',
        inThread: false,
      },
      webhook,
    )
    expect(note).toEqual({ enqueued: [], ignored: 'the repository is read-only' })

    await freeze({ repos: ['libs/open'] }, { frozen: false, reason: 'Reviewed library' })
    const lifted = await dispatch(
      {
        kind: 'note',
        repo: repo('libs/open'),
        mergeRequest: 7,
        mergeRequestState: 'open',
        author: 'jane',
        body: '/holtkeeper review',
        inThread: false,
      },
      webhook,
    )
    expect(lifted.ignored).not.toBe('the repository is read-only')

    const tag = await dispatch(
      { kind: 'tag', repo: repo('libs/ui'), tag: 'v1.0.0', sha: 'a' },
      webhook,
    )
    expect(tag.enqueued).toHaveLength(1)
  })
})
