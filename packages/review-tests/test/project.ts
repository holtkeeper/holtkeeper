import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import { type FileScope, scopeDiff } from '@holtkeeper/review'

export const priceSource = [
  'export function price(amount: number, discount: number): number {',
  '  if (discount < 0 || discount > 1) {',
  "    throw new Error('discount out of range')",
  '  }',
  '  return amount * (1 - discount)',
  '}',
  '',
].join('\n')

/** A small bun project in a temp dir with one existing test, so conventions are detected. */
export async function project(
  extra: Record<string, string> = {},
): Promise<{ dir: string; files: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'hk-review-tests-'))
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'bun test' } }),
    'src/tax.ts': 'export const tax = (amount: number) => amount * 0.2\n',
    'src/tax.test.ts': [
      "import { expect, test } from 'bun:test'",
      '',
      "import { tax } from './tax.ts'",
      '',
      "test('tax', () => {",
      '  expect(tax(10)).toBe(2)',
      '})',
      '',
    ].join('\n'),
    'src/price.ts': priceSource,
    ...extra,
  }
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }),
  )
  return { dir, files }
}

/** The scope of a merge request that adds `text` as `path`. */
export function addedScope(path: string, text: string): FileScope[] {
  const lines = text.replace(/\n$/, '').split('\n')
  const diff = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n')
  return scopeDiff([{ oldPath: path, newPath: path, status: 'added', diff }], { ignore: [] }).files
}

/** An agent that answers with `answers` in order and records the tasks. */
export function scriptedAgent(answers: unknown[]) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'scripted',
    async run(task) {
      tasks.push(task)
      const output = answers.shift()
      return { text: JSON.stringify(output ?? null), output: output as never, turns: 1 }
    },
  }
  return { agent, tasks }
}

export const priceTest = [
  "import { expect, test } from 'bun:test'",
  '',
  "import { price } from './price.ts'",
  '',
  "test('applies the discount', () => {",
  '  expect(price(100, 0.25)).toBe(75)',
  '})',
  '',
  "test('rejects a discount over 1', () => {",
  '  expect(() => price(100, 2)).toThrow()',
  '})',
  '',
].join('\n')
