import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentCommands, detectChecks, parseStatus, taskBranch, taskSlug } from './workspace.ts'

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

const project = async (files: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'write-task-checks-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  return dir
}

describe('branch names', () => {
  test('use the task id and a short slug of the title', () => {
    expect(taskBranch('ab12cd', 'Fix: Widget sizes (ABC-123) in the Shape panel!')).toBe(
      'holtkeeper/ab12cd-fix-widget-sizes-abc-123-in-the-shape-pa',
    )
    expect(taskSlug('???')).toBe('task')
  })
})

describe('parseStatus', () => {
  test('reads changes, renames and untracked files, skipping node_modules', () => {
    expect(
      parseStatus(
        ' M src/a.ts\0?? src/b.ts\0 D old.ts\0R  new.ts\0was.ts\0?? node_modules/x/i.js\0',
      ),
    ).toEqual([
      { path: 'src/a.ts', action: 'update' },
      { path: 'src/b.ts', action: 'create' },
      { path: 'old.ts', action: 'delete' },
      { path: 'was.ts', action: 'delete' },
      { path: 'new.ts', action: 'create' },
    ])
  })
})

describe('detectChecks', () => {
  test('runs the package scripts through the lockfile manager after install', async () => {
    const dir = await project({
      'package.json': JSON.stringify({
        scripts: { typecheck: 'tsc', lint: 'oxlint', 'fmt:check': 'oxfmt --check', test: 'vitest' },
      }),
      'pnpm-lock.yaml': '',
      'go.mod': 'module example.test/widgets\n',
    })
    expect((await detectChecks(dir)).map((check) => check.command)).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm run typecheck',
      'pnpm run lint',
      'pnpm run fmt:check',
      'pnpm run test',
      'gofmt -l',
      'go vet ./...',
      'go test ./...',
    ])
  })

  test('configured checks replace the detection; agent commands add mise and read-only git', async () => {
    const dir = await project({ 'package.json': '{"scripts":{"test":"bun test"}}' })
    const checks = await detectChecks(dir, ['make test'])
    expect(checks).toEqual([{ name: 'check 1', command: 'make test' }])
    expect(agentCommands(checks)).toEqual([
      'make test',
      'mise exec -- make test',
      'git status',
      'git diff',
      'git log',
    ])
    expect(await detectChecks(await project({}))).toEqual([])
  })

  test('a repository with no tests by design leaves out test checks unless configured', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { lint: 'oxlint', test: 'vitest' } }),
      'bun.lock': '',
      'go.mod': 'module example.test/widgets\n',
    })
    expect((await detectChecks(dir, undefined, { tests: false })).map((c) => c.command)).toEqual([
      'bun install --frozen-lockfile',
      'bun run lint',
      'gofmt -l',
      'go vet ./...',
    ])
    expect(await detectChecks(dir, ['make test'], { tests: false })).toEqual([
      { name: 'check 1', command: 'make test' },
    ])
  })
})
