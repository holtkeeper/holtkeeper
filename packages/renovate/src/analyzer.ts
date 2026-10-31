import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineAnalyzer } from '@holtkeeper/analyzer'
import type { GitForge } from '@holtkeeper/forge'

import { opensMergeRequests, renovateConfig, renovateEnv, renovatePlatform } from './config.ts'
import type { RenovateData, RenovateMergeRequest } from './model.ts'
import { renovatePresets, type RenovateOptions, renovateOptionsSchema } from './options.ts'
import { type RenovateBranch, parseRenovateReport } from './parse.ts'
import { type ForgeProxy, startForgeProxy } from './proxy.ts'
import { renovateAnalysis } from './report.ts'

/** The Renovate release the analyzer runs unless `command` says otherwise. */
export const RENOVATE_VERSION = '44.164.10'

/**
 * Runs the pinned Renovate with npx on Node 24 from mise; both are fetched on first use and cached.
 * Not mise's `npm:` backend: its trust policy rejects a transitive dependency of this release.
 */
export const defaultRenovateCommand = [
  'mise',
  'exec',
  'node@24',
  '--',
  'npx',
  '--yes',
  `renovate@${RENOVATE_VERSION}`,
]

const RECENT_DAYS = 30

const lastLines = (value: string, count: number) =>
  value.replace(/\s+$/, '').split('\n').slice(-count).join('\n')

/**
 * Renovate merge requests of a repository: open ones and those merged or closed in the last
 * `RECENT_DAYS`, matched by `branchPrefix`, with the head pipeline of open ones and what the
 * report says about their branch.
 */
export async function renovateMergeRequests(input: {
  forge: GitForge
  repo: string
  branchPrefix: string
  branches: RenovateBranch[]
  now: Date
}): Promise<RenovateMergeRequest[]> {
  const { forge, repo } = input
  const byBranch = new Map(input.branches.map((branch) => [branch.branch, branch]))
  const since = new Date(input.now.getTime() - RECENT_DAYS * 86_400_000).toISOString()

  const listed = forge.listMergeRequests
    ? (await forge.listMergeRequests(repo, { updatedAfter: since, limit: 200 })).filter(
        (mr) =>
          mr.sourceBranch.startsWith(input.branchPrefix) &&
          (mr.state === 'open' || (mr.mergedAt ?? mr.closedAt ?? mr.updatedAt) >= since),
      )
    : []
  const known = new Set(listed.map((mr) => mr.id))
  const missing = input.branches.flatMap((branch) =>
    branch.mergeRequest !== undefined && !known.has(branch.mergeRequest)
      ? [branch.mergeRequest]
      : [],
  )
  const getMergeRequest = forge.getMergeRequest?.bind(forge)
  const fetched = getMergeRequest
    ? await Promise.all(missing.map((id) => getMergeRequest(repo, id).catch(() => undefined)))
    : []
  const all = [
    ...listed,
    ...fetched.flatMap((mr) => (mr ? [{ ...mr, mergedAt: undefined, headSha: mr.headSha }] : [])),
  ]

  return Promise.all(
    all.map(async (mr): Promise<RenovateMergeRequest> => {
      const branch = byBranch.get(mr.sourceBranch)
      let pipeline: RenovateMergeRequest['pipeline']
      if (mr.state === 'open') {
        const sha = mr.headSha ?? (await getMergeRequest?.(repo, mr.id))?.headSha
        const [latest] = sha ? await forge.listPipelines(repo, { sha }).catch(() => []) : []
        pipeline = latest?.status
      }
      return {
        id: mr.id,
        url: mr.webUrl,
        title: mr.title,
        branch: mr.sourceBranch,
        state: mr.state,
        draft: mr.draft,
        ...(pipeline && { pipeline }),
        ...(branch?.result && { result: branch.result }),
        types: branch?.types ?? [],
        updates: branch?.updates ?? 0,
        ...(mr.mergedAt && { mergedAt: mr.mergedAt }),
      }
    }),
  ).then((list) => list.toSorted((a, b) => b.id - a.id))
}

/**
 * The `renovate` analyzer (scope `repo`, needs `forge` and `forgeAccess`): runs Renovate for one
 * repository with a config built from the `analyzers.renovate` setting and reports what it found.
 * In `report` mode, and always on read-only repositories, it is a lookup-only dry run that pushes
 * nothing; in `merge-requests` mode Renovate opens and maintains its merge requests. When the
 * forge gives its `fetch`, Renovate's API calls go through a loopback proxy on it, so they share
 * the token's rate limits with every other job and are counted in `apiRequests`. `command`
 * replaces how Renovate is started; `now` exists for tests.
 */
export function createRenovateAnalyzer(settings: { command?: string[]; now?: () => Date } = {}) {
  const command = settings.command ?? defaultRenovateCommand
  const now = settings.now ?? (() => new Date())
  return defineAnalyzer<RenovateData, RenovateOptions>({
    kind: 'renovate',
    analysis: renovateAnalysis,
    scope: 'repo',
    exclusive: true,
    needs: { forge: true, forgeAccess: true },
    options: renovateOptionsSchema,
    presets: renovatePresets,
    editor: 'renovate',
    flags: [
      { flag: 'mode', option: 'mode', description: 'report (default) or merge-requests' },
      { flag: 'updates', option: 'updates', description: 'all (default) or security' },
    ],
    async run({ repo, forge, forgeAccess, runner, options, signal, log }) {
      if (!forge || !forgeAccess)
        throw new Error('the renovate analyzer needs a forge and its token')
      const started = now()
      const mode = opensMergeRequests(options, forgeAccess) ? 'merge-requests' : 'report'
      if (options.mode === 'merge-requests' && forgeAccess.readOnly)
        log?.('renovate: the repository is read-only, looking up updates only')

      const work = await mkdtemp(join(tmpdir(), 'holtkeeper-renovate-'))
      let proxy: ForgeProxy | undefined
      try {
        if (forgeAccess.fetch)
          proxy = startForgeProxy({
            target: renovatePlatform(forgeAccess).endpoint,
            fetch: forgeAccess.fetch,
          })
        const reportPath = join(work, 'report.json')
        const configFile = join(work, 'config.json')
        const config = renovateConfig({
          options,
          access: forgeAccess,
          repo: repo.path,
          reportPath,
          baseDir: join(work, 'base'),
          ...(proxy && { proxy: proxy.origin }),
        })
        await Bun.write(configFile, JSON.stringify(config, null, 2))
        log?.(
          `renovate ${RENOVATE_VERSION}: ${mode === 'report' ? 'looking up updates' : 'updating merge requests'}`,
        )
        const result = await runner.run(command, {
          cwd: work,
          env: renovateEnv({ configFile, access: forgeAccess, proxied: Boolean(proxy) }),
          timeoutMs: options.timeoutMinutes * 60_000,
          ...(signal && { signal }),
        })
        const output = lastLines(
          [result.stdout, result.stderr].filter(Boolean).join('\n'),
          80,
        ).replaceAll(forgeAccess.token, '***')

        const base = {
          mode,
          readOnly: forgeAccess.readOnly,
          renovateVersion: RENOVATE_VERSION,
          startedAt: started.toISOString(),
          output,
          ...(proxy && { apiRequests: proxy.requests }),
        } as const
        const report = Bun.file(reportPath)
        if (!(await report.exists())) {
          log?.(`renovate: exited with ${result.exitCode} and wrote no report`)
          return {
            data: {
              ...base,
              status: 'failed',
              durationMs: now().getTime() - started.getTime(),
              dependencies: 0,
              outdated: 0,
              managers: [],
              updates: [],
              deprecated: [],
              mergeRequests: [],
              problems: [
                {
                  level: 'fatal',
                  message: `Renovate exited with ${result.exitCode} without a report`,
                },
              ],
            },
          }
        }
        const { branches, ...parsed } = parseRenovateReport(await report.text(), repo.path)
        const mergeRequests = await renovateMergeRequests({
          forge,
          repo: repo.path,
          branchPrefix: options.branchPrefix,
          branches,
          now: now(),
        })
        const failed = result.exitCode !== 0 || parsed.problems.some((p) => p.level === 'fatal')
        log?.(
          `renovate: ${parsed.outdated} of ${parsed.dependencies} dependencies outdated, ${parsed.updates.length} updates, ${mergeRequests.filter((mr) => mr.state === 'open').length} open merge requests`,
        )
        return {
          data: {
            ...base,
            ...parsed,
            status: failed ? 'failed' : 'ok',
            durationMs: now().getTime() - started.getTime(),
            mergeRequests,
          },
        }
      } finally {
        await proxy?.stop()
        await rm(work, { recursive: true, force: true })
      }
    },
  })
}

/** The `renovate` analyzer with the pinned Renovate and the real clock. */
export const renovateAnalyzer = createRenovateAnalyzer()
