import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { localTools } from './local-tools.ts'
import type { AgentCapability, AgentTool } from './types.ts'

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function checkout() {
  dir = await mkdtemp(join(tmpdir(), 'hk-local-tools-'))
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1\nexport const b = 2\n')
  return dir
}

const byName = (tools: AgentTool[]) => new Map(tools.map((tool) => [tool.name, tool]))

async function call(
  tools: Map<string, AgentTool>,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const found = tools.get(name)
  if (!found) throw new Error(`no tool ${name}`)
  try {
    return await found.run(found.input.parse(input), {
      dir,
      signal: new AbortController().signal,
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const toolsFor = (capabilities: AgentCapability[], runner?: ReturnType<typeof createFakeRunner>) =>
  byName(localTools(capabilities, runner ? { runner: runner.runner } : {}))

describe('localTools', () => {
  test('grants tools per capability; run needs a runner', () => {
    expect(localTools(['read', 'search', 'edit', 'run']).map((tool) => tool.name)).toEqual([
      'read_file',
      'glob',
      'grep',
      'edit_file',
      'write_file',
    ])
  })

  test('reads, greps, edits and writes inside the checkout', async () => {
    const repo = await checkout()
    const tools = toolsFor(['read', 'search', 'edit'])
    expect(await call(tools, 'read_file', { path: 'src/a.ts' })).toContain('1\texport const a = 1')
    expect(await call(tools, 'grep', { pattern: 'const b' })).toBe('src/a.ts:2: export const b = 2')
    await call(tools, 'edit_file', { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 3' })
    await call(tools, 'write_file', { path: 'src/new/b.ts', content: 'export {}\n' })
    expect(await call(tools, 'glob', { pattern: '**/*.ts' })).toBe('src/a.ts\nsrc/new/b.ts')
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toBe(
      'export const a = 3\nexport const b = 2\n',
    )
  })

  test('refuses paths outside the checkout and symlinks out of it', async () => {
    const repo = await checkout()
    const outside = await mkdtemp(join(tmpdir(), 'hk-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(repo, 'link'))
    const tools = toolsFor(['read'])
    try {
      const results = [
        await call(tools, 'read_file', { path: '/etc/passwd' }),
        await call(tools, 'read_file', { path: '../x' }),
        await call(tools, 'read_file', { path: 'link/secret.txt' }),
        await call(tools, 'glob', { pattern: '../**' }),
      ]
      expect(results.every((text) => text.includes('outside the working directory'))).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('run_command goes through the runner in the checkout', async () => {
    const repo = await checkout()
    const fake = createFakeRunner(() => ({ exitCode: 1, stdout: 'FAIL a.test.ts', stderr: '' }))
    const tools = toolsFor(['run'], fake)
    expect(await call(tools, 'run_command', { command: 'bun test' })).toBe(
      'exit code 1\nFAIL a.test.ts',
    )
    expect(fake.calls.map((c) => [c.command, c.options.cwd])).toEqual([
      [['sh', '-c', 'bun test'], repo],
    ])
  })
})
