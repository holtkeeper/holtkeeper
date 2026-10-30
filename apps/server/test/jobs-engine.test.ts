import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import type { AnyAnalyzer } from '@holtkeeper/jobs'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { analyzerSettings, scopedAnalyzerOptions, startJobs } from '../src/jobs.ts'

const echo: AnyAnalyzer = {
  kind: 'echo',
  analysis: { kind: 'echo', label: 'Echo' } as AnyAnalyzer['analysis'],
  scope: 'repo',
  needs: {},
  options: z.object({ depth: z.coerce.number().default(1), mode: z.enum(['a', 'b']).default('a') }),
  run: async ({ options }) => ({ data: options }),
}

const now = () => new Date()

const forge = { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never }
const base = { forges: { work: forge }, groups: { games: { forge: 'work', include: ['games/*'] } } }

describe('server jobs', () => {
  test('analyzerSettings validates partial options without adding defaults', () => {
    const [setting] = analyzerSettings([echo])
    expect(setting).toMatchObject({ key: 'analyzers.echo', label: 'Echo', section: 'Analyzers' })
    expect(setting?.schema.parse({ depth: 3 })).toEqual({ depth: 3 })
    expect(setting?.schema.safeParse({ mode: 'c' }).success).toBeFalse()
    expect(setting?.schema.safeParse({ nope: 1 }).success).toBeFalse()
    expect(z.toJSONSchema(setting!.form!, { io: 'input' })).toMatchObject({
      type: 'object',
      properties: { depth: { default: 1 }, mode: { enum: ['a', 'b'], default: 'a' } },
    })
    expect(z.toJSONSchema(setting!.form!, { io: 'input' })).not.toHaveProperty('required')
    expect(setting?.presets).toBeUndefined()
  })

  test('analyzerSettings offers analyzer presets as values that pass the setting', () => {
    const [setting] = analyzerSettings([
      { ...echo, presets: [{ id: 'deep', label: 'Deep', options: { depth: 9 } }] },
    ])
    expect(setting?.presets).toEqual([{ id: 'deep', label: 'Deep', value: { depth: 9 } }])
    expect(setting?.schema.safeParse(setting.presets?.[0]?.value).success).toBeTrue()
  })

  test('scopedAnalyzerOptions picks the most specific setting for the job', async () => {
    const store = memoryStore()
    const config = parseConfig(base)
    const at = '2026-10-30T10:00:00.000Z'
    await store.settings.put({
      id: 's1',
      key: 'analyzers.echo',
      scope: { all: true },
      value: { depth: 2 },
      secret: false,
      updatedAt: at,
    })
    await store.settings.put({
      id: 's2',
      key: 'analyzers.echo',
      scope: { groups: ['games'] },
      value: { depth: 5 },
      secret: false,
      updatedAt: at,
    })
    const job = await store.jobs.enqueue({
      analyzer: 'echo',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      createdAt: at,
    })
    expect(await scopedAnalyzerOptions(config, store, job)).toEqual({ depth: 5 })
    const other = { ...job, repo: { forge: 'work', path: 'tools/x' } }
    expect(await scopedAnalyzerOptions(config, store, other)).toEqual({ depth: 2 })
  })

  test('startJobs is off without a jobs section and runs jobs with one', async () => {
    const store = memoryStore()
    const lines: string[] = []
    expect(
      await startJobs({ config: parseConfig(base), store, analyzers: [echo], now, log: () => {} }),
    ).toBeUndefined()

    await store.settings.put({
      id: 's1',
      key: 'analyzers.echo',
      scope: { all: true },
      value: { depth: 4 },
      secret: false,
      updatedAt: now().toISOString(),
    })
    const job = await store.jobs.enqueue({
      analyzer: 'echo',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'schedule',
      options: { depth: 2, mode: 'b' },
      createdAt: now().toISOString(),
    })
    const engine = await startJobs({
      config: parseConfig({ ...base, jobs: {} }),
      store,
      analyzers: [echo],
      now,
      log: (l) => lines.push(l),
    })
    for (let i = 0; i < 50 && (await store.jobs.get(job.id))?.status !== 'succeeded'; i++)
      await Bun.sleep(10)
    await engine?.stop()

    const done = await store.jobs.get(job.id)
    expect(done?.status).toBe('succeeded')
    expect((await store.analyses.get(done?.analysisId ?? ''))?.data).toEqual({
      depth: 4,
      mode: 'b',
    })
    expect((await store.activity.list()).map((e) => e.action)).toEqual(['job.succeeded'])
    expect(lines.some((l) => l.startsWith('jobs:'))).toBeTrue()
  })

  test('audit jobs get the audit settings and repository traits and store an audit run', async () => {
    const store = memoryStore()
    const config = parseConfig({
      ...base,
      repos: { 'games/*': { traits: { ssr: false } } },
      jobs: {},
    })
    const at = now().toISOString()
    const allowlist = [{ id: 'GHSA-1', reason: 'not reachable' }]
    await store.settings.put({
      id: 'f',
      key: 'audit.fix',
      scope: { all: true },
      value: true,
      secret: false,
      updatedAt: at,
    })
    await store.settings.put({
      id: 'a',
      key: 'audit.allowlist',
      scope: { groups: ['games'] },
      value: allowlist,
      secret: false,
      updatedAt: at,
    })
    const report = {
      scanner: 'osv-scanner',
      findings: [],
      ignored: [],
      expired: [],
      fixes: [],
      resolved: [],
      changedFiles: [],
    }
    let seen: unknown
    const audit: AnyAnalyzer = {
      kind: 'audit',
      analysis: { kind: 'audit', label: 'Audit' } as AnyAnalyzer['analysis'],
      scope: 'repo',
      needs: {},
      options: z.object({}).loose(),
      run: async ({ options }) => {
        seen = options
        return { data: report }
      },
    }
    const job = await store.jobs.enqueue({
      analyzer: 'audit',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      createdAt: at,
      actor: 'jane',
    })
    expect(await scopedAnalyzerOptions(config, store, job)).toEqual({
      fix: true,
      allowlist,
      traits: { ssr: false },
    })

    const engine = await startJobs({ config, store, analyzers: [audit], now, log: () => {} })
    for (let i = 0; i < 50 && (await store.jobs.get(job.id))?.status !== 'succeeded'; i++)
      await Bun.sleep(10)
    await engine?.stop()

    expect(seen).toMatchObject({ fix: true, traits: { ssr: false } })
    const [run] = await store.auditRuns.list({})
    expect(run).toMatchObject({
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      actor: 'jane',
      report,
    })
  })
})
