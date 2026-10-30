import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Finding, Fixer, Scanner } from '@holtkeeper/vuln'

import { parseTraits } from '../src/audit.ts'
import { cli } from '../src/cli.ts'

const config = join(import.meta.dir, 'fixtures/holtkeeper.config.ts')

const lodash: Finding = {
  id: 'GHSA-lodash',
  aliases: ['CVE-2021-23337'],
  summary: 'Command injection',
  severity: 'high',
  url: 'https://osv.dev/vulnerability/GHSA-lodash',
  package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
  source: 'package-lock.json',
  fixedVersions: ['4.17.21'],
}

let scans: Finding[][] = []
const uploads: { url: string; body: unknown }[] = []
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  uploads.push({
    url: url instanceof Request ? url.url : url.toString(),
    body: JSON.parse(typeof init?.body === 'string' ? init.body : 'null'),
  })
  return Response.json({ run: { id: 'run-1' } }, { status: 201 })
}) as typeof fetch
const scanner: Scanner = { name: 'fake', scan: async () => scans.shift() ?? [] }
const fixer: Fixer = {
  name: 'fake-fix',
  supports: () => true,
  fix: async ({ findings }) => ({
    changedFiles: ['package-lock.json'],
    fixed: findings.map((f) => f.id),
    notes: [],
  }),
}

async function run(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await cli(
    argv,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { audit: () => ({ scanner, fixers: [fixer] }), fetch: fakeFetch, untilStopped: async () => {} },
  )
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('cli', () => {
  test('prints usage without a command', async () => {
    const result = await run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('Usage: holtkeeper')
  })

  test('validates a config', async () => {
    const result = await run('validate-config', '--config', config)
    expect(result).toEqual({
      code: 0,
      out: 'config is valid: 1 forge(s), 1 group(s), 1 plugin(s)',
      err: '',
    })
  })

  test('reports a missing config', async () => {
    const result = await run('validate-config', '-c', 'missing.config.ts')
    expect(result.code).toBe(1)
    expect(result.err).toContain('config not found')
  })

  test('explains a repository', async () => {
    const result = await run('explain', 'work:games/app-x', '-c', config)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual({
      repo: { forge: 'work', path: 'games/app-x' },
      groups: ['games'],
      traits: { ssr: true },
      plugins: [{ name: 'greeter', options: { greeting: 'hi' } }],
    })
  })

  test('rejects a malformed repository', async () => {
    const result = await run('explain', 'games/app-x', '-c', config)
    expect(result.code).toBe(1)
    expect(result.err).toContain('<forge>:<path>')
  })

  test('rejects unknown commands', async () => {
    const result = await run('nope')
    expect(result.code).toBe(1)
    expect(result.err).toContain('unknown command "nope"')
  })

  describe('audit', () => {
    test('reports findings and exits with 1', async () => {
      scans = [[lodash]]
      const result = await run('audit', '/tmp')
      expect(result.code).toBe(1)
      expect(result.out).toContain('fake: 1 vulnerable, 0 allowlisted')
      expect(result.out).toContain(
        'high     lodash@4.17.15  GHSA-lodash  package-lock.json  fix 4.17.21',
      )
    })

    test('fixes, rescans and exits with 0 when nothing is left', async () => {
      scans = [[lodash], []]
      const result = await run('audit', '/tmp', '--fix')
      expect(result.code).toBe(0)
      expect(result.out).toContain('fake: 0 vulnerable, 0 allowlisted, 1 fixed')
      expect(result.out).toContain('fixer fake-fix on package-lock.json: claimed 1/1')
    })

    test('applies an allowlist with traits and prints JSON', async () => {
      const allowlist = join(tmpdir(), 'holtkeeper-allowlist.json')
      await Bun.write(
        allowlist,
        JSON.stringify([{ id: 'CVE-2021-23337', reason: 'no SSR', when: { ssr: false } }]),
      )
      scans = [[lodash]]
      const result = await run(
        'audit',
        '/tmp',
        '--allowlist',
        allowlist,
        '--trait',
        'ssr=false',
        '--json',
      )
      expect(result.code).toBe(0)
      expect(JSON.parse(result.out)).toMatchObject({
        findings: [],
        ignored: [{ entry: { reason: 'no SSR' } }],
      })
    })

    test('uploads reports to a server', async () => {
      scans = [[lodash]]
      const result = await run(
        'audit',
        '/tmp',
        '--upload',
        'http://keeper.test/',
        '--repo',
        'work:games/a',
      )
      expect(result.err).toContain('uploaded: http://keeper.test/audits/run-1')
      expect(uploads.at(-1)).toMatchObject({
        url: 'http://keeper.test/api/audit-runs',
        body: {
          repo: { forge: 'work', path: 'games/a' },
          trigger: 'cli',
          report: { findings: [{ id: 'GHSA-lodash' }] },
        },
      })
      expect((await run('audit', '/tmp', '--upload', 'http://keeper.test')).err).toContain(
        '--upload needs --repo',
      )
    })

    test('rejects a broken allowlist', async () => {
      const allowlist = join(tmpdir(), 'holtkeeper-allowlist.json')
      await Bun.write(allowlist, JSON.stringify([{ id: 'X' }]))
      const result = await run('audit', '/tmp', '--allowlist', allowlist)
      expect(result.code).toBe(1)
      expect(result.err).toContain('invalid allowlist')
    })
  })
})

describe('parseTraits', () => {
  test('coerces booleans and numbers', () => {
    expect(parseTraits(['ssr=false', 'node=22', 'runtime=browser', 'empty='])).toEqual({
      ssr: false,
      node: 22,
      runtime: 'browser',
      empty: '',
    })
  })

  test('rejects pairs without a key', () => {
    expect(() => parseTraits(['=x'])).toThrow('key=value')
  })
})
