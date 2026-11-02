import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import { defaultReviewTestOptions } from '@holtkeeper/review'

import { addedScope, priceSource, priceTest, project, scriptedAgent } from '../test/project.ts'
import { createMergeRequestTester } from './tester.ts'

const HEAD = 'a'.repeat(40)
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(extra: Record<string, string> = {}) {
  const { dir } = await project({ 'node_modules/.keep': '', ...extra })
  dirs.push(dir)
  return dir
}

const written = (path = 'src/price.test.ts') => ({ path, content: priceTest, notes: 'covers it' })

function input(dir: string, agent: Agent, runner: CommandRunner) {
  return {
    dir,
    runner,
    agent,
    files: addedScope('src/price.ts', priceSource),
    headSha: HEAD,
    mergeRequest: { title: 'Add discounts', description: 'Prices accept a discount.' },
    options: defaultReviewTestOptions,
  }
}

const tester = createMergeRequestTester({ install: false, build: false })

describe('createMergeRequestTester', () => {
  test('a test that passes every run is offered and removed from the checkout', async () => {
    const dir = await setup()
    const seen: boolean[] = []
    const { runner, calls } = createFakeRunner((command) => {
      if (command.includes('./src/price.test.ts'))
        seen.push(existsSync(join(dir, 'src/price.test.ts')))
      return { exitCode: 0, stdout: '2 pass' }
    })
    const { agent, tasks } = scriptedAgent([written()])

    const run = await tester.test(input(dir, agent, runner))

    expect(run.skipped).toBeUndefined()
    expect(run.items).toHaveLength(1)
    const [item] = run.items
    expect(item).toMatchObject({
      testFile: 'src/price.test.ts',
      framework: 'bun:test',
      command: ['bun', 'test', './src/price.test.ts'],
      cwd: '.',
      verdict: 'passes',
      head: { passed: 2, runs: 2 },
      attempts: 1,
      content: priceTest,
      ranAt: HEAD,
      target: { path: 'src/price.ts', symbol: 'price', startLine: 1, endLine: 6 },
    })
    expect(seen).toEqual([true, true])
    expect(existsSync(join(dir, 'src/price.test.ts'))).toBe(false)
    expect(calls.every((call) => call.options.timeoutMs === 120_000)).toBe(true)
    expect(tasks[0]?.capabilities).toEqual(['read', 'search'])
    expect(tasks[0]?.taskKind).toBe('tests')
    expect(tasks[0]?.prompt).toContain('Add discounts')
    expect(tasks[0]?.prompt).toContain("throw new Error('discount out of range')")
  })

  test('a failing run goes back to the agent with the output until the test passes', async () => {
    const dir = await setup()
    let runs = 0
    const { runner } = createFakeRunner(() =>
      ++runs === 1 ? { exitCode: 1, stderr: 'expected 75, received 80' } : { exitCode: 0 },
    )
    const { agent, tasks } = scriptedAgent([
      written(),
      { verdict: 'fixed', content: priceTest, notes: 'fixed the import' },
    ])

    const run = await tester.test(input(dir, agent, runner))

    expect(run.items[0]).toMatchObject({
      verdict: 'passes',
      attempts: 2,
      notes: 'fixed the import',
    })
    expect(tasks[1]?.prompt).toContain('expected 75, received 80')
    expect(tasks[1]?.prompt).toContain('`src/price.test.ts`')
  })

  test('the agent saying the code is wrong ends the loop as unfinished', async () => {
    const dir = await setup()
    const { runner } = createFakeRunner(() => ({ exitCode: 1, stdout: 'expected throw' }))
    const { agent } = scriptedAgent([
      written(),
      { verdict: 'code-wrong', content: priceTest, notes: 'a discount of 2 is accepted' },
    ])

    const run = await tester.test(input(dir, agent, runner))

    expect(run.items[0]).toMatchObject({
      verdict: 'unfinished',
      attempts: 2,
      reason: 'the agent judges the code wrong: a discount of 2 is accepted',
      output: 'expected throw',
    })
  })

  test('a test that never passes stops after the attempts', async () => {
    const dir = await setup()
    const { runner } = createFakeRunner(() => ({ exitCode: 1 }))
    const fix = { verdict: 'fixed', content: priceTest, notes: '' }
    const { agent, tasks } = scriptedAgent([written(), fix, fix])

    const run = await tester.test(input(dir, agent, runner))

    expect(run.items[0]).toMatchObject({
      verdict: 'unfinished',
      attempts: 3,
      reason: 'did not pass in 3 attempt(s)',
    })
    expect(tasks).toHaveLength(3)
  })

  test('a test that passes only some runs is flaky', async () => {
    const dir = await setup()
    let runs = 0
    const { runner } = createFakeRunner(() => ({ exitCode: ++runs === 2 ? 1 : 0 }))
    const { agent } = scriptedAgent([written()])

    const run = await tester.test({
      ...input(dir, agent, runner),
      options: { ...defaultReviewTestOptions, repeat: 3 },
    })

    expect(run.items[0]).toMatchObject({
      verdict: 'flaky',
      head: { passed: 2, runs: 3 },
      reason: 'passed 2 of 3 runs',
    })
  })

  test('a path that breaks the convention or exists is refused before running', async () => {
    const dir = await setup()
    const { runner, calls } = createFakeRunner()
    const { agent } = scriptedAgent([written('src/tax.test.ts')])

    const run = await tester.test(input(dir, agent, runner))

    expect(run.items).toEqual([])
    expect(run.notTested).toEqual([
      {
        path: 'src/price.ts',
        symbol: 'price',
        reason: 'unusable test path src/tax.test.ts: file already exists',
      },
    ])
    expect(calls).toEqual([])
  })

  test('a function whose existing test fails on the head gets no test', async () => {
    const dir = await setup({ 'src/price.test.ts': priceTest })
    const { runner } = createFakeRunner(() => ({ exitCode: 1 }))
    const { agent, tasks } = scriptedAgent([])

    const run = await tester.test(input(dir, agent, runner))

    expect(run.notTested).toEqual([
      {
        path: 'src/price.ts',
        symbol: 'price',
        reason: 'its existing test src/price.test.ts fails on the head',
      },
    ])
    expect(tasks).toEqual([])
  })

  test('a test of an unchanged function from the previous review is kept without running', async () => {
    const dir = await setup()
    const { runner } = createFakeRunner()
    const first = await tester.test(input(dir, scriptedAgent([written()]).agent, runner))
    const { runner: again, calls } = createFakeRunner()
    const { agent, tasks } = scriptedAgent([])

    const run = await tester.test({
      ...input(dir, agent, again),
      headSha: 'b'.repeat(40),
      previous: first.items,
    })

    expect(run.items).toEqual(first.items)
    expect(tasks).toEqual([])
    expect(calls).toEqual([])
  })

  test('functions over the limit are listed as not tested', async () => {
    const dir = await setup({ 'src/total.ts': totalSource })
    const { runner } = createFakeRunner()
    const { agent } = scriptedAgent([written()])

    const run = await tester.test({
      ...input(dir, agent, runner),
      files: [
        ...addedScope('src/price.ts', priceSource),
        ...addedScope('src/total.ts', totalSource),
      ],
      options: { ...defaultReviewTestOptions, maxTests: 1 },
    })

    expect(run.items.map((item) => item.target.symbol)).toEqual(['price'])
    expect(run.notTested).toEqual([
      { path: 'src/total.ts', symbol: 'total', reason: 'over the limit of 1 test(s) per run' },
    ])
  })

  test('a project without a test framework is skipped', async () => {
    const { dir } = await project()
    dirs.push(dir)
    await rm(join(dir, 'src/tax.test.ts'))
    await Bun.write(join(dir, 'package.json'), JSON.stringify({ name: 'shop' }))
    const { runner } = createFakeRunner()

    const run = await tester.test(input(dir, scriptedAgent([]).agent, runner))

    expect(run).toEqual({ skipped: 'no test framework detected', items: [], notTested: [] })
  })
})

const totalSource = [
  'export function total(items: number[]): number {',
  '  let sum = 0',
  '  for (const item of items) sum += item',
  '  return sum',
  '}',
  '',
].join('\n')
