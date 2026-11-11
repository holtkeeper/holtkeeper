import type { Agent } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'
import type { ForgeFetch, GitForge, RepoRef } from '@holtkeeper/forge'
import type { AnalysisKind } from '@holtkeeper/report'
import type { AnalysisStore, AuditRunStore, CiJobStore } from '@holtkeeper/store'
import type { z } from 'zod'

import type { Applicability } from './applies.ts'
import { defaultBranchHead } from './head.ts'

export * from './applies.ts'
export * from './head.ts'

/**
 * Bytes kept between runs, e.g. on S3, under keys the analyzer derives from its inputs (source
 * hash, settings, tool versions). Entries may vanish at any time, so a miss is normal; methods
 * never throw. `artifactCache` from `@holtkeeper/artifacts` has this shape.
 */
export interface RunCache {
  get(
    key: string,
  ): Promise<{ data: Uint8Array; meta: Record<string, string | number | boolean> } | undefined>
  set(
    key: string,
    data: Uint8Array,
    entry?: {
      meta?: Record<string, string | number | boolean>
      contentType?: string
      name?: string
    },
  ): Promise<void>
}

/**
 * What an external tool needs to act on a forge as Holtkeeper does: the API token and, when the
 * forge has a signing key, the key and identity commits must carry. Never log or store it.
 */
export interface ForgeAccess {
  /** Adapter kind, e.g. `gitlab` or `github`. */
  kind: string
  /** Base web URL of the forge, e.g. `https://gitlab.example.com`. */
  url: string
  token: string
  /**
   * The forge's own `fetch`, drawing from the same per-token limits as Holtkeeper's forge client;
   * route the tool's API calls through it. Absent when the adapter does not use `fetch`.
   */
  fetch?: ForgeFetch
  signing?: { privateKey: string; name: string; email: string }
  /** The repository is read-only for Holtkeeper: the tool must not push or open merge requests. */
  readOnly: boolean
}

/** Everything an analyzer may use; what is present depends on its `needs`. */
export interface AnalyzerContext<Options> {
  /** Repository analyzed; for group analyzers `{ forge, path: <group name> }`. */
  repo: RepoRef
  /** Local checkout of `repo` at `ref`, for analyzers that need one. */
  dir?: string
  /**
   * Read-only checkouts of the repositories `requiredCheckouts` asked for, by `forge:path`.
   * Removed after the run; analyzers must not change them.
   */
  checkouts?: Record<string, string>
  /**
   * Checks out any repository on demand, e.g. each repository of a group. Every call returns a
   * private temporary working tree at `ref` (default branch when omitted); `writable` ones are
   * meant to be modified by the analyzer, read-only ones must not be. Call `cleanup` when done;
   * the runner also removes every checkout still left after the run. `runner`, when present, runs
   * commands for that checkout with its own toolchain and sandbox (the task engine always sets it);
   * use it instead of `runner` for commands in `dir`.
   */
  checkout?: (
    repo: RepoRef,
    options?: { ref?: string; writable?: boolean },
  ) => Promise<{
    dir: string
    sha: string
    ref: string
    cleanup: () => Promise<void>
    runner?: CommandRunner
    /**
     * Present when the forge has a signing key: commits made through it are signed with that key
     * and pushed over git. Publish changes through it rather than the forge API to keep them signed.
     */
    publisher?: {
      commit(input: { message: string; paths?: string[] }): Promise<{ sha: string } | undefined>
      push(input: { branch: string }): Promise<{ pushed: boolean; sha: string }>
    }
  }>
  /** Repositories of the group, for group analyzers. */
  repos?: RepoRef[]
  /** Forge client of `repo`'s forge. */
  forge?: GitForge
  /** Raw access to `repo`'s forge, for analyzers that hand it to an external tool. */
  forgeAccess?: ForgeAccess
  runner: CommandRunner
  /** Configured LLM agent, when there is one. */
  agent?: Agent
  /** Earlier results, for analyzers that build on other analyses. */
  history?: {
    analyses: AnalysisStore
    auditRuns: AuditRunStore
    /** CI job attempts kept between runs, for analyzers that accumulate job history. */
    ciJobs?: CiJobStore
  }
  /** Results of expensive work shared between runs (encoded image variants, ...), when the runner has a store. */
  cache?: RunCache
  /** Release, tag or commit being analyzed, when the trigger knows it. */
  ref?: string
  options: Options
  /** Id of the job this run belongs to; absent outside the task engine. */
  jobId?: string
  signal?: AbortSignal
  log?: (line: string) => void
  /**
   * Runs `run` as a named step of the job's log: start and end are marked with the duration, lines
   * logged meanwhile belong to the step, and a step that throws is recorded as the failing step of
   * the attempt (the error is rethrown). Absent outside the task engine; then call `run` directly.
   */
  step?: <T>(name: string, run: () => Promise<T>) => Promise<T>
}

/** A binary file a run produced, kept outside the JSON data. */
export interface AnalyzerArtifact {
  /** Content address the data refers to, the SHA-256 of `data` in hex. */
  id: string
  data: Uint8Array
  contentType?: string
  /** Suggested file name, e.g. the repository path it would be written to. */
  name?: string
}

/** A command-line flag that sets one option. */
export interface AnalyzerFlag {
  flag: string
  option: string
  description: string
  type?: 'string' | 'boolean'
}

/** A named set of options, e.g. a license policy for commercial products. */
export interface AnalyzerPreset<Options = Record<string, unknown>> {
  /** Unique within the analyzer. */
  id: string
  label: string
  description?: string
  /** Options the preset sets; others keep their current values. */
  options: Partial<Options>
}

/** A duration such as `30m`, `6h` or `7d`. */
export type RefreshInterval = `${number}${'m' | 'h' | 'd'}`

/**
 * When the freshness sweeper queues an analyzer on its own. `change`: the default branch moved
 * past the commit the latest record describes, at most once per `minInterval`; with `paths`, only
 * changes to matching files (globs from the repository root) count. `time`: the data changes
 * without commits (registries, advisories, end-of-life dates, CI history), so it reruns once
 * `cadence` has passed since the latest record. `heavy` holds the run to the night window.
 */
export type AnalyzerRefresh =
  | { on: 'change'; minInterval: RefreshInterval; paths?: readonly string[]; heavy?: boolean }
  | { on: 'time'; cadence: RefreshInterval; heavy?: boolean }

/**
 * Something that produces analysis data, run by the task engine on schedules, events and demand.
 * Analyzers declare what they need; runners provide exactly that.
 */
export interface Analyzer<Data = unknown, Options = Record<string, unknown>> {
  kind: string
  // oxlint-disable-next-line typescript/no-explicit-any -- the kind may be shared with other analyzers
  analysis: AnalysisKind<any>
  /** `repo`: one repository at a time. `group`: all repositories of a config group at once. */
  scope: 'repo' | 'group'
  /**
   * `true`: the runner must provide it. `'optional'`: provided when the runner can, and `run`
   * copes without it.
   */
  needs: {
    checkout?: boolean
    forge?: boolean | 'optional'
    /** `context.forgeAccess`: the forge token for tools that call the forge themselves. */
    forgeAccess?: boolean | 'optional'
    agent?: 'required' | 'optional'
    history?: boolean | 'optional'
  }
  /**
   * The run changes repositories: pushes branches, commits, opens or updates merge requests. The
   * queue runs such a job alone on its `repo` (the group for group analyzers); jobs of other
   * analyzers of one repository run side by side.
   */
  exclusive?: boolean
  /**
   * Worker pool that alone runs its jobs, e.g. `write` for tasks that change code. Workers serve
   * the pools they are started with (`DEFAULT_POOL` unless told otherwise) and never claim jobs
   * of other pools. Absent: `DEFAULT_POOL`.
   */
  pool?: string
  /**
   * The run reads only the default branch and rejects a `ref`, so event triggers and merge request
   * policies, whose jobs carry one, never queue it.
   */
  defaultBranchOnly?: boolean
  /**
   * Kinds whose results of the same `repo` the run reads from `history`. The queue starts its job
   * only once jobs of these kinds of that repository queued ahead of it have ended.
   */
  after?: string[]
  /**
   * After storing a new record, runners delete this kind's older records of the same `repo`,
   * keeping the newest `keepRecords`. Absent: every record is kept.
   */
  keepRecords?: number
  /**
   * How the freshness sweeper keeps this analyzer's records current. Absent: never automatically,
   * only on events, schedules people create and demand (merge request review, write tasks).
   * Group analyzers have no commit of their own and use `time`.
   */
  refresh?: AnalyzerRefresh
  /** Validates options from config or flags; numbers should use `z.coerce`. */
  options: z.ZodType<Options>
  flags?: AnalyzerFlag[]
  /** Named option sets the panel offers for the analyzer's `analyzers.<kind>` setting. */
  presets?: AnalyzerPreset<Options>[]
  /** Names a dedicated panel editor for the `analyzers.<kind>` setting instead of the generated form. */
  editor?: string
  /**
   * Other repositories the run reads besides `repo` (a shared config repository, a dependency's
   * source, ...). `repo` may be a `RepoRef` or `forge:path`; `ref` defaults to the default branch.
   * Runners check them out before `run` and pass the directories in `context.checkouts`.
   */
  requiredCheckouts?(options: Options, repo: RepoRef): { repo: RepoRef | string; ref?: string }[]
  /**
   * Whether a repository uses what the analyzer works on. Schedules check it before queueing a
   * repository job, so repositories that start or stop using it join or leave on the next run
   * without config changes; a check that throws counts as applying. Absent: every repository
   * applies. Manual runs skip it, so `run` must still cope with a repository it does not apply to.
   */
  appliesTo?: Applicability
  /**
   * Produces the data. `artifacts` are binary files the data refers to by `id` (e.g. the
   * `artifact` of `write-binary` edits); runners store them after the record, tagged with it.
   * `at` (ISO 8601) is when the analyzed subject happened, such as a release's tag date; runners
   * record the analysis at that time instead of the time of the run. `sha` is the commit the data
   * describes; runners record the checkout's commit when it is absent, so analyzers without a
   * checkout set it to the forge head they read.
   */
  run(context: AnalyzerContext<Options>): Promise<{
    data: Data
    ref?: string
    sha?: string
    at?: string
    artifacts?: AnalyzerArtifact[]
  }>
}

/** The pool of analyzers that name none, served by every worker started without `pools`. */
export const DEFAULT_POOL = 'default'

export const defineAnalyzer = <Data, Options>(analyzer: Analyzer<Data, Options>) => analyzer

/** An analyzer whose data and option types are not known statically, e.g. in a registry. */
// oxlint-disable-next-line typescript/no-explicit-any -- registries hold analyzers of many types
export type AnyAnalyzer = Analyzer<any, any>

/**
 * `analyzer` reporting the default-branch head as its record's `sha` when it ran on the default
 * branch without a checkout and returned none, so freshness can compare it with later heads. The
 * head is read before the run: a push during the run leaves the record stale, never falsely fresh.
 */
export function withDefaultBranchHead<Data, Options>(
  analyzer: Analyzer<Data, Options>,
): Analyzer<Data, Options> {
  return {
    ...analyzer,
    async run(context) {
      const sha =
        context.forge && context.ref === undefined && context.repos === undefined
          ? await defaultBranchHead(context.forge, context.repo.path)
          : undefined
      const result = await analyzer.run(context)
      return result.sha !== undefined || sha === undefined ? result : { ...result, sha }
    },
  }
}
