import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner } from '@holtkeeper/exec'

import { lintCheck, oxlintAdapter } from '../src/index.ts'

const oxlint = join(import.meta.dir, '../../../node_modules/.bin/oxlint')

test.skipIf(!(await Bun.file(oxlint).exists()))('runs the real oxlint through SARIF', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quality-lint-oxlint-'))
  try {
    await mkdir(join(dir, 'src'))
    await Bun.write(join(dir, '.oxlintrc.json'), '{}')
    await Bun.write(join(dir, 'src/a.js'), 'const unused = 1\ndebugger\n')
    await Bun.write(
      join(dir, 'src/b.ts'),
      'var a = 1;\nif (!a instanceof Object) {}\nexport default a\n',
    )

    const base = oxlintAdapter()
    const check = lintCheck({ adapters: [{ ...base, command: () => [oxlint, '-f', 'sarif'] }] })
    expect(await check.detect(dir)).toBe(true)
    const result = await check.run({ dir, runner: localRunner })

    expect(result.version).toMatch(/^oxlint \d+\.\d+\.\d+/)
    expect(
      result.issues
        ?.map((issue) => `${issue.file}:${issue.range?.start.line} ${issue.rule}`)
        .toSorted(),
    ).toEqual([
      'src/a.js:1 eslint(no-unused-vars)',
      'src/a.js:2 eslint(no-debugger)',
      'src/b.ts:2 eslint(no-unsafe-negation)',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
