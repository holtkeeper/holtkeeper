import { expect, test } from 'bun:test'

import { cli } from '../src/cli.ts'

async function run(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await cli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('prints usage without a command', async () => {
  const result = await run()
  expect(result.code).toBe(1)
  expect(result.out).toContain('Usage: holtkeeper')
  expect((await run('--help')).code).toBe(0)
})

test('rejects unknown commands and missing configs', async () => {
  const unknown = await run('audit')
  expect(unknown.code).toBe(1)
  expect(unknown.err).toContain('unknown command "audit"')
  const missing = await run('users', 'list', '-c', 'missing.config.ts')
  expect(missing.code).toBe(1)
  expect(missing.err).toContain('config not found')
})
