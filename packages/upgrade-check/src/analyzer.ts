import type { Toolset } from '@holtkeeper/agent'
import { defineAnalyzer } from '@holtkeeper/analyzer'
import type { RepoRef } from '@holtkeeper/forge'

import { type UpgradePoint, runUpgradeCheck } from './agent.ts'
import { upgradeCheckAnalysis } from './analysis.ts'
import {
  type RangeSource,
  commitSubjects,
  diffFilesSource,
  gitRangeSource,
  resolveCommit,
} from './git.ts'
import {
  UPGRADE_CHECK_KIND,
  type UpgradeCheckData,
  type UpgradeCheckOptions,
  upgradeCheckOptionsSchema,
  upgradeCheckRef,
} from './schema.ts'

/** The range a check runs on, for the hooks of `UpgradeCheckDeps`. */
export interface UpgradeRange {
  from: UpgradePoint
  to: UpgradePoint
}

/** What the host provides besides the analyzer context. All optional. */
export interface UpgradeCheckDeps {
  /**
   * The public API and dependency changes of the range as markdown, when the job's options do not
   * carry them (`apiChanges`, `dependencyChanges` win). A failure leaves them out.
   */
  inputsFor?: (
    repo: RepoRef,
    range: UpgradeRange & { signal?: AbortSignal },
  ) => Promise<{ apiChanges?: string; dependencyChanges?: string }>
  /**
   * Team rules for the agents' stable context (e.g. the rules of the `release` agent). A failure
   * leaves them out.
   */
  contextFor?: (repo: RepoRef) => Promise<string | undefined>
  /** Extra toolsets of the area passes; the host attaches its per-task-kind toolsets itself. */
  toolsetsFor?: (context: { repo: RepoRef; dir: string }) => readonly Toolset[]
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The `upgrade-check` analyzer: an AI check of what breaks when an installation upgrades from
 * `from` to `to` (`runUpgradeCheck`). Scope `repo`; needs a checkout (jobs set `ref` to the `to`
 * sha), the forge and an agent. Never runs on its own: it has no `refresh` and is meant to be
 * queued on demand only. Both refs are resolved in the checkout (never fetched) and the changed
 * files read with `git diff`; when `from` cannot be found the forge's
 * `compareCommits` is used instead. The record's `ref` is `upgradeCheckRef(fromSha, toSha)` and its
 * `sha` the `to` commit.
 */
export function createUpgradeCheckAnalyzer(deps: UpgradeCheckDeps = {}) {
  return defineAnalyzer<UpgradeCheckData, UpgradeCheckOptions>({
    kind: UPGRADE_CHECK_KIND,
    analysis: upgradeCheckAnalysis,
    scope: 'repo',
    needs: { checkout: true, forge: true, agent: 'required' },
    keepRecords: 50,
    options: upgradeCheckOptionsSchema,
    flags: [
      { flag: 'from', option: 'from', description: 'commit sha or tag installed now (required)' },
      { flag: 'to', option: 'to', description: 'commit sha or tag to upgrade to (required)' },
    ],
    async run(context) {
      const { options, repo } = context
      const agent = context.agent
      if (!agent) throw new Error('upgrade-check needs an agent')
      if (!context.dir) throw new Error('upgrade-check needs a checkout')
      const dir = context.dir
      const git = { runner: context.runner, dir, signal: context.signal }
      const step = <T>(name: string, work: () => Promise<T>) =>
        context.step ? context.step(name, work) : work()
      const { fromSha, toSha, source } = await step('changes', async () => {
        const target = await resolveCommit(git, options.to)
        if (!target) throw new Error(`cannot find ${options.to} in the checkout`)
        const base = await resolveCommit(git, options.from)
        let changes: RangeSource | undefined
        if (base) {
          changes = await gitRangeSource(git, base, target).catch((error: unknown) => {
            context.log?.(`git diff failed: ${errorText(error)}`)
            return undefined
          })
        }
        if (!changes) {
          if (!context.forge?.compareCommits)
            throw new Error(`cannot read the changes from ${options.from} to ${options.to}`)
          context.log?.('reading the changes from the forge')
          changes = diffFilesSource(
            await context.forge.compareCommits(repo.path, base ?? options.from, target),
          )
        }
        return { fromSha: base ?? options.from, toSha: target, source: changes }
      })
      const from: UpgradePoint = {
        ref: options.from,
        sha: fromSha,
        ...(options.fromLabel && { label: options.fromLabel }),
      }
      const to: UpgradePoint = {
        ref: options.to,
        sha: toSha,
        ...(options.toLabel && { label: options.toLabel }),
      }
      const commits = options.commits ?? (await commitSubjects(git, fromSha, toSha))
      const inputs =
        options.apiChanges !== undefined && options.dependencyChanges !== undefined
          ? {}
          : ((await deps
              .inputsFor?.(repo, { from, to, ...(context.signal && { signal: context.signal }) })
              .catch((error: unknown) => {
                context.log?.(`computed changes failed: ${errorText(error)}`)
                return undefined
              })) ?? {})
      const apiChanges = options.apiChanges ?? inputs.apiChanges
      const dependencyChanges = options.dependencyChanges ?? inputs.dependencyChanges
      const rules = await deps.contextFor?.(repo).catch((error: unknown) => {
        context.log?.(`rules lookup failed: ${errorText(error)}`)
        return undefined
      })
      const toolsets = deps.toolsetsFor?.({ repo, dir })
      const data = await step('check', () =>
        runUpgradeCheck({
          agent,
          dir,
          from,
          to,
          source,
          commits,
          ...(apiChanges && { apiChanges }),
          ...(dependencyChanges && { dependencyChanges }),
          ...(rules && { context: rules }),
          ...(toolsets?.length && { toolsets }),
          ...(options.costLimitUsd !== undefined && { costLimitUsd: options.costLimitUsd }),
          ...(context.signal && { signal: context.signal }),
          ...(context.log && { log: context.log }),
        }),
      )
      return { data, ref: upgradeCheckRef(fromSha, toSha), sha: toSha }
    },
  })
}

/** The `upgrade-check` analyzer without computed changes, rules or extra toolsets. */
export const upgradeCheckAnalyzer = createUpgradeCheckAnalyzer()
