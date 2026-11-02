import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'

import { detectTestSetup } from '@holtkeeper/quality-tests'

import { addedScope, priceSource, project } from '../test/project.ts'
import { findTargets, functionHash, outermost, targetId } from './targets.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const fn = (name: string, startLine: number, endLine: number) => ({
  name,
  kind: 'function' as const,
  startLine,
  endLine,
  branches: 0,
})

describe('outermost', () => {
  test('drops functions nested in another one', () => {
    const outer = fn('outer', 1, 10)
    expect(outermost([outer, fn('inner', 3, 5), fn('next', 12, 14)])).toEqual([
      outer,
      fn('next', 12, 14),
    ])
  })
})

describe('functionHash', () => {
  test('changes only with the function text', () => {
    const text = 'a\nb\nc\n'
    expect(functionHash(text, { startLine: 1, endLine: 2 })).toBe(
      functionHash('a\nb\nd\n', { startLine: 1, endLine: 2 }),
    )
    expect(functionHash(text, { startLine: 1, endLine: 2 })).not.toBe(
      functionHash('a\nx\nc\n', { startLine: 1, endLine: 2 }),
    )
  })
})

describe('findTargets', () => {
  test('keeps changed source functions and skips tests, types and tiny changes', async () => {
    const types = 'export interface Price {\n  amount: number\n  currency: string\n}\n'
    const tiny = 'export function one() {\n  return 1\n}\n'
    const { dir } = await project({ 'src/types.ts': types, 'src/one.ts': tiny })
    dirs.push(dir)
    const setup = await detectTestSetup(dir)

    const { targets, notTested } = await findTargets({
      dir,
      setup,
      minLines: 4,
      files: [
        ...addedScope('src/price.ts', priceSource),
        ...addedScope('src/types.ts', types),
        ...addedScope('src/one.ts', tiny),
        ...addedScope('src/tax.test.ts', 'test()\n'),
      ],
    })

    expect(notTested).toEqual([])
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      id: targetId('src/price.ts', 'price'),
      path: 'src/price.ts',
      symbol: 'price',
      startLine: 1,
      endLine: 6,
      added: 6,
      language: 'js',
      framework: 'bun:test',
    })
  })

  test('functions in a language without a framework are not tested', async () => {
    const { dir } = await project({
      'tool/main.py': 'def run(x):\n    y = x + 1\n    z = y * 2\n    return z\n',
    })
    dirs.push(dir)
    const setup = await detectTestSetup(dir)

    const { targets, notTested } = await findTargets({
      dir,
      setup,
      minLines: 3,
      files: addedScope(
        'tool/main.py',
        'def run(x):\n    y = x + 1\n    z = y * 2\n    return z\n',
      ),
    })

    expect(targets).toEqual([])
    expect(notTested).toEqual([
      { path: 'tool/main.py', symbol: 'run', reason: 'no python test framework detected' },
    ])
  })
})
