import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import type { ForgeAccess } from '@holtkeeper/analyzer'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { GitForge, MergeRequestRecord } from '@holtkeeper/forge'

import { createRenovateAnalyzer, defaultRenovateCommand } from './analyzer.ts'
import { renovateOptionsSchema } from './options.ts'
import { renovateReport } from './report.ts'

const now = new Date('2026-10-31T12:00:00Z')
const access: ForgeAccess = {
  kind: 'gitlab',
  url: 'https://gitlab.example.com',
  token: 'glpat-secret',
  readOnly: false,
}

const record = (input: Partial<MergeRequestRecord> & { id: number }): MergeRequestRecord => ({
  title: `MR ${input.id}`,
  description: '',
  sourceBranch: `renovate/${input.id}`,
  targetBranch: 'main',
  state: 'open',
  draft: false,
  labels: [],
  author: 'bot',
  webUrl: `https://gitlab.example.com/games/app/-/merge_requests/${input.id}`,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-30T00:00:00Z',
  ...input,
})

function fakeForge() {
  const listed = [
    record({ id: 12, sourceBranch: 'renovate/react-monorepo', headSha: 'aaa' }),
    record({ id: 9, headSha: 'bbb' }),
    record({ id: 7, state: 'merged', mergedAt: '2026-10-25T00:00:00Z' }),
    record({ id: 5, sourceBranch: 'feature/x' }),
  ]
  const forge = {
    listMergeRequests: async () => listed,
    listPipelines: async (_repo: string, { sha }: { sha?: string }) =>
      sha === 'aaa' ? [{ id: 1, ref: '', sha, status: 'failed', webUrl: '' }] : [],
  } as unknown as GitForge
  return forge
}

async function run(options: Record<string, unknown> = {}, forgeAccess = access, report = true) {
  const configs: Record<string, unknown>[] = []
  const fake = createFakeRunner(async (_command, { env }) => {
    const config = (await Bun.file(env!.RENOVATE_CONFIG_FILE!).json()) as Record<string, unknown>
    configs.push(config)
    if (report)
      await Bun.write(
        config.reportPath as string,
        Bun.file(join(import.meta.dir, '../test/report.json')),
      )
    return { stdout: 'INFO: Repository finished (token glpat-secret)', exitCode: report ? 0 : 1 }
  })
  const analyzer = createRenovateAnalyzer({ now: () => now })
  const result = await analyzer.run({
    repo: { forge: 'work', path: 'games/app' },
    forge: fakeForge(),
    forgeAccess,
    runner: fake.runner,
    options: renovateOptionsSchema.parse(options),
  })
  return { data: result.data, calls: fake.calls, configs }
}

describe('renovate analyzer', () => {
  test('runs the pinned Renovate as a lookup with the token in its environment', async () => {
    const { data, calls, configs } = await run()
    expect(calls[0]?.command).toEqual(defaultRenovateCommand)
    expect(calls[0]?.options.env).toMatchObject({ RENOVATE_TOKEN: 'glpat-secret' })
    expect(configs[0]).toMatchObject({ dryRun: 'lookup', repositories: ['games/app'] })
    expect(data).toMatchObject({ status: 'ok', mode: 'report', dependencies: 4, outdated: 3 })
    expect(data.output).not.toContain('glpat-secret')
  })

  test('collects Renovate merge requests with pipelines and branch results', async () => {
    const { data } = await run({ mode: 'merge-requests' })
    expect(data.mode).toBe('merge-requests')
    expect(data.mergeRequests.map((mr) => [mr.id, mr.state, mr.pipeline, mr.result])).toEqual([
      [12, 'open', 'failed', 'done'],
      [9, 'open', undefined, undefined],
      [7, 'merged', undefined, undefined],
    ])
    expect(data.mergeRequests[0]).toMatchObject({ types: ['major'], updates: 2 })
  })

  test('read-only repositories only get a lookup', async () => {
    const { data, configs } = await run({ mode: 'merge-requests' }, { ...access, readOnly: true })
    expect(configs[0]).toMatchObject({ dryRun: 'lookup' })
    expect(data).toMatchObject({ mode: 'report', readOnly: true })
  })

  test('API calls go through the forge fetch and are counted', async () => {
    const limited: string[] = []
    const forgeAccess: ForgeAccess = {
      ...access,
      fetch: async (input) => {
        limited.push(input)
        return Response.json({ version: '18.0.0' })
      },
    }
    const fake = createFakeRunner(async (_command, { env }) => {
      const config = (await Bun.file(env!.RENOVATE_CONFIG_FILE!).json()) as { endpoint: string }
      await fetch(`${config.endpoint}version`, {
        headers: { 'private-token': env!.RENOVATE_TOKEN! },
      })
      await fetch(`${config.endpoint}projects/games%2Fapp`)
      return { exitCode: 1 }
    })
    const { data } = await createRenovateAnalyzer({ now: () => now }).run({
      repo: { forge: 'work', path: 'games/app' },
      forge: fakeForge(),
      forgeAccess,
      runner: fake.runner,
      options: renovateOptionsSchema.parse({}),
    })
    expect(limited).toEqual([
      'https://gitlab.example.com/api/v4/version',
      'https://gitlab.example.com/api/v4/projects/games%2Fapp',
    ])
    expect(data.apiRequests).toBe(2)
    expect(renovateReport(data).metrics.find((m) => m.id === 'api-requests')?.value).toBe(2)
  })

  test('a run without a report is a failed result, not a job failure', async () => {
    const { data } = await run({}, access, false)
    expect(data.status).toBe('failed')
    expect(data.problems[0]?.level).toBe('fatal')
    expect(renovateReport(data).metrics[0]).toMatchObject({ id: 'status', tone: 'bad' })
  })

  test('the report shows updates, merge requests and health', async () => {
    const { data } = await run({ mode: 'merge-requests' })
    const report = renovateReport(data, { ...data, outdated: 5 })
    const byId = Object.fromEntries(report.metrics.map((m) => [m.id, m]))
    expect(byId.outdated).toMatchObject({ value: 3, delta: -2 })
    expect(byId.major?.value).toBe(2)
    expect(byId.security).toMatchObject({ value: 1, tone: 'bad' })
    expect(byId.broken).toMatchObject({ value: 1, tone: 'bad' })
    expect(byId.libyears?.value).toBe(3.5)
    expect(report.sections.map((s) => s.id)).toEqual(['updates', 'merge-requests', 'health'])
    const table = report.sections[1]?.blocks[0]
    expect(table?.type === 'table' && table.rows[0]?.status).toEqual({
      text: 'broken',
      tone: 'bad',
    })
  })
})
