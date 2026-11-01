import { expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import { type HoltkeeperConfig, parseConfig } from '@holtkeeper/core'
import { FakeForge } from '@holtkeeper/release/testing'
import { memoryStore } from '@holtkeeper/store/memory'

import { UsageError } from '../src/audit.ts'
import { type ReleaseFlags, releaseCommand } from '../src/release.ts'

const setup = () => {
  const fake = new FakeForge()
  fake.commitTo('main', 'feat: one')
  fake.tag('v1.0.0')
  fake.commitTo('main', 'fix: two')
  const store = memoryStore()
  const config = {
    ...parseConfig({
      forges: { work: { kind: 'fake', url: '', create: () => fake.forge } },
      groups: { apps: { forge: 'work', include: ['g/app'] } },
    }),
    server: { auth: noAuth(), store, vaultKey: 'v'.repeat(32) },
  } as unknown as HoltkeeperConfig
  const run = async (args: string[], flags: ReleaseFlags = {}) => {
    const out: string[] = []
    const code = await releaseCommand(
      config,
      args,
      flags,
      (line) => out.push(line),
      () => new Date('2026-11-01T00:00:00Z'),
    )
    return { code, out: out.join('\n') }
  }
  return { fake, store, run }
}

test('plans, accepts and versions a trunk repository', async () => {
  const { fake, store, run } = setup()
  const trunk = { repo: 'work:g/app', preset: 'trunk' }
  const planned = await run(['plan'], trunk)
  expect(planned.code).toBe(0)
  expect(planned.out).toContain('Version: 1.0.0 -> 1.0.1 (suggested 1.0.1: patch for 1 fix)')

  await store.settings.put({
    id: 'r',
    key: 'releases',
    scope: { all: true },
    value: { acceptance: { required: true } },
    secret: false,
    updatedAt: '2026-10-01T00:00:00Z',
  })
  expect((await run(['plan'], trunk)).code).toBe(2)
  expect(run(['version'], trunk)).rejects.toBeInstanceOf(UsageError)

  expect((await run(['accept'], { ...trunk, note: 'smoke tests passed' })).out).toStartWith(
    'accepted main at',
  )
  const versioned = await run(['version'], { ...trunk, version: '1.1.0' })
  expect(versioned.out).toStartWith('tagged v1.1.0 at')
  expect(fake.tags[0]?.name).toBe('v1.1.0')
  expect(await store.kv?.get('release:acceptance:work:g/app')).toBeUndefined()
})

test('shows status rows and refuses unknown actions', async () => {
  const { run } = setup()
  const status = await run(['status'], { preset: 'trunk' })
  expect(status.out).toBe(
    'g/app\tawaiting-version\tv1.0.0 -> 1.0.1\tahead 0\tunreleased 1\t-\t-\t-',
  )
  expect(run(['nope'])).rejects.toBeInstanceOf(UsageError)
  expect(run(['plan'], { preset: 'nope', repo: 'work:g/app' })).rejects.toThrow('unknown preset')
})
