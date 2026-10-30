import type { Agent } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import type { AnalysisKind } from '@holtkeeper/report'
import type { AnalysisStore, AuditRunStore, CiJobStore } from '@holtkeeper/store'
import type { z } from 'zod'

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
  signal?: AbortSignal
  log?: (line: string) => void
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

/**
 * Something that produces analysis data: the CLI runs analyzers on demand, the task engine on
 * schedules and events. Analyzers declare what they need; runners provide exactly that.
 */
export interface Analyzer<Data = unknown, Options = Record<string, unknown>> {
  kind: string
  // oxlint-disable-next-line typescript/no-explicit-any -- the kind may be shared with other analyzers
  analysis: AnalysisKind<any>
  /** `repo`: one repository at a time. `group`: all repositories of a config group at once. */
  scope: 'repo' | 'group'
  needs: {
    checkout?: boolean
    forge?: boolean
    agent?: 'required' | 'optional'
    history?: boolean
  }
  /** Validates options from config or flags; numbers should use `z.coerce`. */
  options: z.ZodType<Options>
  flags?: AnalyzerFlag[]
  /** Named option sets the panel offers for the analyzer's `analyzers.<kind>` setting. */
  presets?: AnalyzerPreset<Options>[]
  /**
   * Other repositories the run reads besides `repo` (a shared config repository, a dependency's
   * source, ...). `repo` may be a `RepoRef` or `forge:path`; `ref` defaults to the default branch.
   * Runners check them out before `run` and pass the directories in `context.checkouts`.
   */
  requiredCheckouts?(options: Options, repo: RepoRef): { repo: RepoRef | string; ref?: string }[]
  /**
   * Produces the data. `artifacts` are binary files the data refers to by `id` (e.g. the
   * `artifact` of `write-binary` edits); runners store them after the record, tagged with it.
   * `at` (ISO 8601) is when the analyzed subject happened, such as a release's tag date; runners
   * record the analysis at that time instead of the time of the run.
   */
  run(
    context: AnalyzerContext<Options>,
  ): Promise<{ data: Data; ref?: string; at?: string; artifacts?: AnalyzerArtifact[] }>
}

export const defineAnalyzer = <Data, Options>(analyzer: Analyzer<Data, Options>) => analyzer

/** An analyzer whose data and option types are not known statically, e.g. in a registry. */
// oxlint-disable-next-line typescript/no-explicit-any -- registries hold analyzers of many types
export type AnyAnalyzer = Analyzer<any, any>
