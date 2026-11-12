import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { CredentialInputError, CredentialNotFoundError } from './errors.ts'
import { createCredentialService } from './service.ts'
import type { CreateCredentialInput, TokenRotator } from './types.ts'

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected a rejection')
}

const NOW = new Date('2026-10-30T12:00:00.000Z')

function fakeRotator(overrides: Partial<TokenRotator> = {}) {
  const calls: { url: string; token: string; lifetimeDays: number }[] = []
  let counter = 0
  const rotator: TokenRotator = {
    kind: 'fake',
    async rotate({ url, token, lifetimeDays }) {
      calls.push({ url, token, lifetimeDays })
      counter += 1
      return { token: `rotated-${counter}`, expiresAt: '2027-01-28T00:00:00.000Z' }
    },
    inspect: async () => ({ expiresAt: '2026-11-15', name: 'bot', scopes: ['api'] }),
    ...overrides,
  }
  return { rotator, calls }
}

function setup(rotators: TokenRotator[] = [fakeRotator().rotator]) {
  let tick = NOW.getTime()
  const store = memoryStore()
  const service = createCredentialService({
    credentials: store.credentials,
    audit: store.audit,
    vault: aesVault('a'.repeat(32)),
    rotators,
    now: () => new Date((tick += 1000)),
  })
  return { store, service }
}

const input = (overrides: Partial<CreateCredentialInput> = {}): CreateCredentialInput => ({
  name: 'GitLab bot',
  kind: 'fake',
  url: 'https://gitlab.example.com',
  scope: { all: true },
  secret: 'glpat-secret',
  ...overrides,
})

describe('create', () => {
  test('seals the secret and never returns it', async () => {
    const { store, service } = setup()
    const view = await service.create(input({ expiresAt: '2026-12-01T00:00:00Z' }))

    expect(view).not.toHaveProperty('secret')
    expect(view.expiresAt).toBe('2026-12-01T00:00:00.000Z')
    expect(view.createdAt).toBe('2026-10-30T12:00:01.000Z')
    const stored = await store.credentials.get(view.id)
    expect(stored?.secret).toStartWith('v1.')
    expect(stored?.secret).not.toContain('glpat-secret')
    expect(await service.list()).toEqual([view])
    expect(await service.get(view.id)).toEqual(view)
    expect(await service.reveal(view.id)).toBe('glpat-secret')
  })

  test('fills expiresAt from the rotator when not given', async () => {
    const { service } = setup()
    const view = await service.create(input())
    expect(view.expiresAt).toBe('2026-11-15T00:00:00.000Z')
  })

  test('a failing inspect is not fatal', async () => {
    const { rotator } = fakeRotator({ inspect: () => Promise.reject(new Error('boom')) })
    const { service } = setup([rotator])
    const view = await service.create(input())
    expect(view.expiresAt).toBeUndefined()
  })

  test('rejects invalid input with every issue', async () => {
    const { service } = setup()
    const bad = {
      name: ' ',
      kind: 'fake',
      url: 'not a url',
      scope: { groups: [''] },
      secret: '',
      rotation: { enabled: true, daysBefore: 0, lifetimeDays: 1.5 },
    }
    const error = await errorOf(service.create(bad))
    expect(error).toBeInstanceOf(CredentialInputError)
    const issues =
      error instanceof CredentialInputError ? error.issues.map((issue) => issue.split(':')[0]) : []
    expect(issues).toEqual([
      'name',
      'url',
      'secret',
      'scope.groups.0',
      'rotation.daysBefore',
      'rotation.lifetimeDays',
    ])
    expect(await service.list()).toEqual([])
  })

  test('rejects daysBefore not below lifetimeDays', async () => {
    const { service } = setup()
    const rotation = { enabled: true, daysBefore: 30, lifetimeDays: 30 }
    expect((await errorOf(service.create(input({ rotation })))).message).toMatch(
      'less than rotation.lifetimeDays',
    )
  })
})

describe('update and remove', () => {
  test('re-seals a new secret and re-inspects its expiry', async () => {
    const { service } = setup()
    const { id } = await service.create(input({ expiresAt: '2026-12-01T00:00:00Z' }))
    const view = await service.update(id, { name: 'Renamed', secret: 'glpat-new' })

    expect(view.name).toBe('Renamed')
    expect(view.expiresAt).toBe('2026-11-15T00:00:00.000Z')
    expect(await service.reveal(id)).toBe('glpat-new')
  })

  test('keeps the secret when none is given', async () => {
    const { service } = setup()
    const { id } = await service.create(input())
    await service.update(id, { scope: { groups: ['games'] } })
    expect(await service.reveal(id)).toBe('glpat-secret')
    expect((await service.get(id))?.scope).toEqual({ groups: ['games'] })
  })

  test('capabilities are stored without updatedAt and dropped when the endpoint changes', async () => {
    const { service } = setup()
    const { id, updatedAt } = await service.create(input())
    const capabilities = { agentLoop: 'ok' as const, checkedAt: '2026-10-30T12:00:00.000Z' }
    const probed = await service.setCapabilities(id, capabilities)
    expect(probed).toMatchObject({ capabilities, updatedAt })
    expect((await service.update(id, { name: 'Renamed' })).capabilities).toEqual(capabilities)
    expect((await service.update(id, { url: 'https://other.example.com' })).capabilities).toBe(
      undefined,
    )
    await service.setCapabilities(id, capabilities)
    expect((await service.update(id, { secret: 'glpat-next' })).capabilities).toBeUndefined()
    expect(await errorOf(service.setCapabilities('missing', capabilities))).toBeInstanceOf(
      CredentialNotFoundError,
    )
  })

  test('remove deletes; unknown ids throw', async () => {
    const { service } = setup()
    const { id } = await service.create(input())
    await service.remove(id)
    expect(await service.list()).toEqual([])
    expect(await errorOf(service.remove(id))).toBeInstanceOf(CredentialNotFoundError)
    expect(await errorOf(service.update(id, { name: 'x' }))).toBeInstanceOf(CredentialNotFoundError)
    expect(await errorOf(service.reveal(id))).toBeInstanceOf(CredentialNotFoundError)
  })
})

describe('rotate', () => {
  test('stores the new token and its expiry', async () => {
    const { rotator, calls } = fakeRotator()
    const { service } = setup([rotator])
    const rotation = { enabled: true, daysBefore: 7, lifetimeDays: 90 }
    const { id } = await service.create(input({ rotation }))
    const view = await service.rotate(id)

    expect(calls).toEqual([
      { url: 'https://gitlab.example.com', token: 'glpat-secret', lifetimeDays: 90 },
    ])
    expect(await service.reveal(id)).toBe('rotated-1')
    expect(view).toMatchObject({
      expiresAt: '2027-01-28T00:00:00.000Z',
      lastRotatedAt: view.updatedAt,
    })
  })

  test('records the failure, rethrows and clears it after a later success', async () => {
    let fail = true
    const { rotator } = fakeRotator()
    const flaky: TokenRotator = {
      kind: 'fake',
      rotate: (args) =>
        fail ? Promise.reject(new Error('GitLab 401: revoked')) : rotator.rotate(args),
    }
    const { service } = setup([flaky])
    const { id } = await service.create(input())

    expect((await errorOf(service.rotate(id))).message).toBe('GitLab 401: revoked')
    expect((await service.get(id))?.lastError).toBe('GitLab 401: revoked')
    expect(await service.reveal(id)).toBe('glpat-secret')

    fail = false
    const view = await service.rotate(id)
    expect(view.lastError).toBeUndefined()
  })

  test('refuses a kind without a rotator and keeps the credential untouched', async () => {
    const { service } = setup([])
    const created = await service.create(input({ kind: 'github' }))
    expect(created.rotatable).toBe(false)
    const error = await errorOf(service.rotate(created.id))
    expect(error).toBeInstanceOf(CredentialInputError)
    expect(error.message).toMatch('no token rotator for kind "github"')
    expect(await service.get(created.id)).toEqual(created)
    expect(await service.reveal(created.id)).toBe('glpat-secret')
  })

  test('concurrent calls share one rotation', async () => {
    const { rotator, calls } = fakeRotator()
    const { service } = setup([rotator])
    const { id } = await service.create(input())
    const [a, b] = await Promise.all([service.rotate(id), service.rotate(id)])
    expect(calls).toHaveLength(1)
    expect(a).toEqual(b)
  })
})

describe('rotateDue', () => {
  test('rotates only enabled credentials that expire within daysBefore', async () => {
    const { rotator, calls } = fakeRotator()
    const { store, service } = setup([rotator])
    const policy = { enabled: true, daysBefore: 7, lifetimeDays: 30 }
    const due = await service.create(input({ rotation: policy, expiresAt: '2026-11-05T00:00:00Z' }))
    const expired = await service.create(
      input({ rotation: policy, expiresAt: '2026-10-01T00:00:00Z' }),
    )
    await service.create(input({ rotation: policy, expiresAt: '2026-12-01T00:00:00Z' }))
    await service.create(
      input({ rotation: { ...policy, enabled: false }, expiresAt: '2026-11-01T00:00:00Z' }),
    )
    await service.create(
      input({ kind: 'other', rotation: policy, expiresAt: '2026-11-01T00:00:00Z' }),
    )

    const results = await service.rotateDue()
    expect(results.toSorted((x, y) => x.id.localeCompare(y.id))).toEqual(
      [
        { id: due.id, ok: true },
        { id: expired.id, ok: true },
      ].toSorted((x, y) => x.id.localeCompare(y.id)),
    )
    expect(calls).toHaveLength(2)
    const { events } = await store.audit.list()
    expect(events.map((e) => [e.action, e.actor.id, e.outcome])).toEqual([
      ['credential.rotate', 'system', 'ok'],
      ['credential.rotate', 'system', 'ok'],
    ])
    expect(new Set(events.map((e) => e.target.id))).toEqual(new Set([due.id, expired.id]))
  })
})

describe('credential options', () => {
  test('are stored, shown in views, replaced and removed by an empty object', async () => {
    const { store, service } = setup()
    const created = await service.create(
      input({ kind: 'ai', options: { provider: 'x', headers: { 'X-Team': 'a' } } }),
    )
    expect(created.options).toEqual({ provider: 'x', headers: { 'X-Team': 'a' } })
    expect((await store.credentials.get(created.id))?.options).toEqual(created.options)
    const replaced = await service.update(created.id, { options: { provider: 'y' } })
    expect(replaced.options).toEqual({ provider: 'y' })
    const renamed = await service.update(created.id, { name: 'n' })
    expect(renamed.options).toEqual({ provider: 'y' })
    const cleared = await service.update(created.id, { options: {} })
    expect(cleared.options).toBeUndefined()
    expect((await service.create(input({ options: {} }))).options).toBeUndefined()
  })

  test('must be a JSON object within the size limit', async () => {
    const { service } = setup()
    const invalid = await errorOf(
      service.create(input({ options: ['x'] as unknown as Record<string, unknown> })),
    )
    expect(invalid).toBeInstanceOf(CredentialInputError)
    expect(invalid.message).toContain('options: must be an object')
    const large = await errorOf(service.create(input({ options: { x: 'a'.repeat(20_000) } })))
    expect(large.message).toContain('options: must be at most')
  })

  test('are checked by validateOptions with the resulting kind', async () => {
    const store = memoryStore()
    const seen: [string, unknown][] = []
    const service = createCredentialService({
      credentials: store.credentials,
      vault: aesVault('a'.repeat(32)),
      validateOptions: (kind, options) => {
        seen.push([kind, options])
        if (kind !== 'ai') return undefined
        return options?.['region'] ? [] : ['options.region: required']
      },
    })
    const error = await errorOf(service.create(input({ kind: 'ai' })))
    expect(error).toBeInstanceOf(CredentialInputError)
    expect(error.message).toContain('options.region: required')
    const ok = await service.create(input({ kind: 'ai', options: { region: 'eu' } }))
    await service.update(ok.id, { name: 'renamed' })
    expect(seen).toHaveLength(2)
    expect(await errorOf(service.update(ok.id, { options: {} }))).toBeInstanceOf(
      CredentialInputError,
    )
    expect((await service.get(ok.id))?.options).toEqual({ region: 'eu' })
    await service.create(input({ kind: 'gitlab' }))
  })
})
