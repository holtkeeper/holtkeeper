import { beforeEach, describe, expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
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
const credentials = () =>
  createCredentialService({ credentials: store.credentials, activity: store.activity, vault })

const markReadOnly = (scope: { groups: string[] } | { repos: string[] }, value = true) =>
  store.settings.put({
    id: JSON.stringify(scope),
    key: 'repo.readOnly',
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

describe('repo.readOnly', () => {
  test('resolves by group and by the more specific repository entry', async () => {
    await markReadOnly({ groups: ['libs'] })
    await markReadOnly({ repos: ['libs/open'] }, false)
    const readOnly = readOnlyRepos(store, () => config)
    expect(await readOnly(repo('libs/ui'))).toBe(true)
    expect(await readOnly(repo('libs/open'))).toBe(false)
    expect(await readOnly(repo('games/a'))).toBe(false)
  })

  test('forge clients of the managed config refuse writes to read-only repositories', async () => {
    await markReadOnly({ groups: ['libs'] })
    const managed = await startManagedConfig({
      file: config,
      store,
      vault,
      credentials: credentials(),
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
    await forge?.commentOnMergeRequest('games/a', 1, 'hi')
    expect(comments).toEqual(['games/a'])
    managed.stop()
  })

  test('events of read-only repositories are ignored, except tags', async () => {
    await markReadOnly({ groups: ['libs'] })
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

    const tag = await dispatch(
      { kind: 'tag', repo: repo('libs/ui'), tag: 'v1.0.0', sha: 'a' },
      webhook,
    )
    expect(tag.enqueued).toHaveLength(1)
  })
})
