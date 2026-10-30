import { describe, expect, test } from 'bun:test'

import { ReadOnlyRepositoryError, readOnlyDefinition, readOnlyForge } from './read-only.ts'
import type { ForgeDefinition, GitForge } from './types.ts'

function fakeForge() {
  const calls: string[] = []
  const record = (name: string) => async () => {
    calls.push(name)
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the methods under test
  const forge = {
    kind: 'fake',
    readFile: async () => 'content',
    commit: record('commit'),
    commentOnMergeRequest: record('commentOnMergeRequest'),
    registerSshKey: async () => {
      calls.push('registerSshKey')
      return { id: '1' }
    },
    ensureWebhook: async () => {
      calls.push('ensureWebhook')
      return { id: '1', hooks: [] }
    },
    removeWebhook: record('removeWebhook'),
  } as unknown as GitForge
  return { forge, calls }
}

const lockedLibs = (repo: string) => repo.startsWith('libs/')

const failure = (pending: Promise<unknown> | undefined) =>
  Promise.resolve(pending).then(
    () => undefined,
    (error: unknown) => error,
  )

describe('readOnlyForge', () => {
  test('rejects writes to read-only repositories without calling the forge', async () => {
    const { forge, calls } = fakeForge()
    const guarded = readOnlyForge(forge, lockedLibs)
    const error = await guarded.commentOnMergeRequest('libs/ui', 1, 'hi').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ReadOnlyRepositoryError)
    expect(error).toMatchObject({ repo: 'libs/ui', operation: 'commentOnMergeRequest' })
    expect(calls).toEqual([])
  })

  test('lets reads and writes to other repositories through', async () => {
    const { forge, calls } = fakeForge()
    const guarded = readOnlyForge(forge, async (repo) => lockedLibs(repo))
    expect(await guarded.readFile('libs/ui', 'package.json')).toBe('content')
    await guarded.commentOnMergeRequest('games/app', 1, 'hi')
    expect(calls).toEqual(['commentOnMergeRequest'])
    expect(guarded.kind).toBe('fake')
  })

  test('checks deploy keys and project webhooks, not user keys or group webhooks', async () => {
    const { forge, calls } = fakeForge()
    const guarded = readOnlyForge(forge, lockedLibs)
    const key = { title: 'k', publicKey: 'ssh-ed25519 AAAA', usage: 'auth' as const }
    expect(
      await failure(
        guarded.registerSshKey?.({
          ...key,
          scope: { kind: 'deploy', repo: 'libs/ui', canPush: false },
        }),
      ),
    ).toBeInstanceOf(ReadOnlyRepositoryError)
    await guarded.registerSshKey?.({ ...key, scope: { kind: 'user' } })
    const hook = { url: 'https://h', secret: 's', events: ['push' as const] }
    expect(await failure(guarded.ensureWebhook?.({ project: 'libs/ui' }, hook))).toBeInstanceOf(
      ReadOnlyRepositoryError,
    )
    await guarded.ensureWebhook?.({ group: 'libs' }, hook)
    await guarded.removeWebhook?.([{ id: '1', scope: 'project', target: 'libs/ui' }])
    expect(calls).toEqual(['registerSshKey', 'ensureWebhook', 'removeWebhook'])
  })

  test('keeps optional methods absent', () => {
    const { forge } = fakeForge()
    expect(Reflect.get(readOnlyForge(forge, lockedLibs), 'submitReview')).toBeUndefined()
  })
})

describe('readOnlyDefinition', () => {
  test('guards clients of the definition and of its withFetch copies', async () => {
    const { forge, calls } = fakeForge()
    const definition: ForgeDefinition = {
      kind: 'fake',
      url: 'https://forge',
      create: () => forge,
      withFetch: () => definition,
    }
    const guarded = readOnlyDefinition(definition, lockedLibs)
    const commit = { branch: 'b', message: 'm', changes: [] }
    expect(await failure(guarded.create().commit('libs/ui', commit))).toBeInstanceOf(
      ReadOnlyRepositoryError,
    )
    const copy = guarded.withFetch?.((fetch) => fetch)
    expect(await failure(copy?.create().commit('libs/ui', commit))).toBeInstanceOf(
      ReadOnlyRepositoryError,
    )
    expect(calls).toEqual([])
  })
})
