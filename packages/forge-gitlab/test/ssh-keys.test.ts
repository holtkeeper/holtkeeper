import { describe, expect, test } from 'bun:test'

import { gitlab, GitLabApiError } from '../src/index.ts'
import { FakeGitLabKeys } from './fake-gitlab-keys.ts'

const publicKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBGy3aZ5cKD6hIzKGVwmV3d1K9QlMUwSNmCNlKXJcYkP holtkeeper'
const otherKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHf0BpYB9d1sHyPZcKLmKX8W5t1MnQE0e7oX6l1yXh2B other'

function setup() {
  const server = new FakeGitLabKeys()
  const forge = gitlab({ url: server.base, token: server.token, fetch: server.fetch }).create()
  return { server, forge }
}

describe('user SSH keys', () => {
  test('register with usage_type and expiry, list and remove', async () => {
    const { server, forge } = setup()
    const { id } = await forge.registerSshKey!({
      title: 'holtkeeper bot',
      publicKey,
      usage: 'signing',
      expiresAt: '2027-01-01T00:00:00.000Z',
      scope: { kind: 'user' },
    })
    expect(server.calls.at(-1)).toEqual({
      method: 'POST',
      path: 'user/keys',
      body: {
        title: 'holtkeeper bot',
        key: publicKey,
        expires_at: '2027-01-01T00:00:00.000Z',
        usage_type: 'signing',
      },
    })
    expect(await forge.listSshKeys!({ kind: 'user' })).toEqual([
      {
        id,
        title: 'holtkeeper bot',
        publicKey,
        usage: 'signing',
        expiresAt: '2027-01-01T00:00:00.000Z',
        createdAt: '2026-10-30T00:00:00.000Z',
      },
    ])
    await forge.removeSshKey!(id, { kind: 'user' })
    expect(server.userKeys.size).toBe(0)
  })

  test('surfaces GitLab errors such as a duplicate key', async () => {
    const { forge } = setup()
    await forge.registerSshKey!({ title: 'a', publicKey, usage: 'auth', scope: { kind: 'user' } })
    const promise = forge.registerSshKey!({
      title: 'b',
      publicKey,
      usage: 'auth',
      scope: { kind: 'user' },
    })
    expect(promise).rejects.toBeInstanceOf(GitLabApiError)
    expect(promise).rejects.toThrow('has already been taken')
  })

  test('rejects non-numeric ids before calling GitLab', async () => {
    const { server, forge } = setup()
    expect(forge.removeSshKey!('../projects', { kind: 'user' })).rejects.toThrow('numeric')
    expect(server.calls).toHaveLength(0)
  })
})

describe('deploy keys', () => {
  test('register with can_push, list per project and remove from one project', async () => {
    const { server, forge } = setup()
    const { id } = await forge.registerSshKey!({
      title: 'holtkeeper push',
      publicKey,
      usage: 'auth',
      scope: { kind: 'deploy', repo: 'games/a', canPush: true },
    })
    expect(server.calls.at(-1)).toEqual({
      method: 'POST',
      path: 'projects/games/a/deploy_keys',
      body: { title: 'holtkeeper push', key: publicKey, can_push: true },
    })
    const listed = await forge.listSshKeys!({ kind: 'deploy', repo: 'games/a' })
    expect(listed).toMatchObject([{ id, publicKey, usage: 'auth', canPush: true }])
    expect(await forge.listSshKeys!({ kind: 'deploy', repo: 'games/b' })).toEqual([])

    await forge.enableDeployKey!(id, { kind: 'deploy', repo: 'games/b', canPush: true })
    expect(server.calls.slice(-2).map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST projects/games/b/deploy_keys/${id}/enable`,
      `PUT projects/games/b/deploy_keys/${id}`,
    ])
    expect(await forge.listSshKeys!({ kind: 'deploy', repo: 'games/b' })).toMatchObject([
      { id, canPush: true },
    ])

    await forge.removeSshKey!(id, { kind: 'deploy', repo: 'games/a' })
    expect(await forge.listSshKeys!({ kind: 'deploy', repo: 'games/a' })).toEqual([])
    expect(await forge.listSshKeys!({ kind: 'deploy', repo: 'games/b' })).toHaveLength(1)
  })

  test('enabling read-only skips the can_push update', async () => {
    const { server, forge } = setup()
    const { id } = await forge.registerSshKey!({
      title: 'ro',
      publicKey: otherKey,
      usage: 'auth',
      scope: { kind: 'deploy', repo: 'games/a', canPush: false },
    })
    await forge.enableDeployKey!(id, { kind: 'deploy', repo: 'games/b', canPush: false })
    expect(server.calls.at(-1)?.path).toBe(`projects/games/b/deploy_keys/${id}/enable`)
  })

  test('refuses signing usage for deploy keys', async () => {
    const { server, forge } = setup()
    const promise = forge.registerSshKey!({
      title: 'x',
      publicKey,
      usage: 'auth_and_signing',
      scope: { kind: 'deploy', repo: 'games/a', canPush: false },
    })
    expect(promise).rejects.toThrow('deploy keys can only authenticate')
    expect(server.calls).toHaveLength(0)
  })
})
