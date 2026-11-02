import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { localRunner } from '@holtkeeper/exec'
import { defaultReviewTestOptions } from '@holtkeeper/review'

import { createMergeRequestTester } from '../src/index.ts'
import { addedScope, priceSource, priceTest, project, scriptedAgent } from './project.ts'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('createMergeRequestTester on a real bun project', () => {
  test.skipIf(!Bun.which('bun'))(
    'runs the written test, fixes a wrong expectation and leaves the checkout clean',
    async () => {
      const { dir } = await project()
      dirs.push(dir)
      const wrong = priceTest.replace('toBe(75)', 'toBe(80)')
      const { agent, tasks } = scriptedAgent([
        { path: 'src/price.test.ts', content: wrong, notes: '' },
        { verdict: 'fixed', content: priceTest, notes: '25% off 100 is 75' },
      ])

      const run = await createMergeRequestTester({ install: false, build: false }).test({
        dir,
        runner: localRunner,
        agent,
        files: addedScope('src/price.ts', priceSource),
        headSha: 'a'.repeat(40),
        mergeRequest: { title: 'Add discounts', description: '' },
        options: defaultReviewTestOptions,
      })

      expect(run.items[0]).toMatchObject({
        verdict: 'passes',
        attempts: 2,
        head: { passed: 2, runs: 2 },
      })
      expect(tasks[1]?.prompt).toContain('80')
      expect(existsSync(join(dir, 'src/price.test.ts'))).toBe(false)
    },
    60_000,
  )
})
