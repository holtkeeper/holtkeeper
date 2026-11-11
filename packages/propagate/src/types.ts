import type { CommandRunner } from '@holtkeeper/exec'

/** Package ecosystem in OSV spelling. */
export type Ecosystem = 'npm' | 'Go'

/** A package to roll out, as options give it. `version` is exact or `latest`. */
export interface PackageRequest {
  name: string
  version: string
  /** Default `npm`. */
  ecosystem?: Ecosystem
}

/** A package with its target version resolved. */
export interface PackageTarget {
  name: string
  ecosystem: Ecosystem
  /** What options asked for: an exact version or `latest`. */
  requested: string
  /** Exact version rolled out, without a leading `v` for npm and with it for Go. */
  version: string
}

/** Where a manifest declares a package. */
export type UsageKind =
  | 'prod'
  | 'dev'
  | 'peer'
  | 'optional'
  | 'override'
  | 'resolution'
  | 'catalog'
  | 'go'

/** One declaration of a target package in one manifest. */
export interface Usage {
  package: string
  ecosystem: Ecosystem
  /** Repository-relative file holding the declaration: `package.json`, `pnpm-workspace.yaml`, `go.mod`. */
  manifest: string
  /** Key path of the value inside the manifest, e.g. `['devDependencies', 'react']`, `['catalogs', 'legacy', 'react']`. */
  path: string[]
  kind: UsageKind
  /** Range or version as written. */
  declared: string
  /** Lowest version `declared` admits; absent for specs that name no registry version. */
  current?: string
  /** Value the bump writes; absent when the declaration is already on the target or cannot be bumped. */
  next?: string
  /** Why the declaration is left alone, when it is. */
  note?: string
}

/** What planning found in one repository, without a checkout. */
export interface RepoPlan {
  usages: Usage[]
  notes: string[]
}

/** One manifest value changed by a bump. */
export interface Bump {
  package: string
  /** Value before the bump, as written. */
  from: string
  /** Value after the bump, as written. */
  to: string
  manifest: string
}

/** Outcome of one verification command. */
export interface CheckResult {
  name: string
  command: string
  exitCode: number
  ok: boolean
  /** Last 200 lines of stdout and stderr, trimmed. */
  output: string
  durationMs: number
}

/** Release notes found for one package between its old and new version. */
export interface ReleaseNotes {
  package: string
  from?: string
  to: string
  /** Where the text came from, e.g. `node_modules/react/CHANGELOG.md`, `work:libs/ui tags`. */
  source: string
  /** Markdown, trimmed. */
  text: string
}

export type RepoStatus = 'unchanged' | 'skipped' | 'updated' | 'failed' | 'error'

/** Result of rolling the wave out to one repository. */
export interface RepoOutcome {
  repo: string
  webUrl?: string
  status: RepoStatus
  /** Every target declaration found, bumped or not. */
  usages: Usage[]
  bumps: Bump[]
  /** Result of every check after the bump. */
  checks: CheckResult[]
  /** Files changed in the checkout, published or not. */
  changedFiles: string[]
  /** The write task proposed to make the failing checks pass (`PropagationData.fixGroup`). */
  fixTask?: string
  mergeRequest?: { id: number; url: string; draft: boolean }
  notes: string[]
  error?: string
}

/** Everything the `propagation` analysis stores for one wave. */
export interface PropagationData {
  group: string
  packages: PackageTarget[]
  dryRun: boolean
  repos: RepoOutcome[]
  releaseNotes: ReleaseNotes[]
  /** Task group of the write tasks proposed for repositories whose checks fail after the bump. */
  fixGroup?: string
}

/** A shell command run as one check; `env` is merged over the process environment. */
export interface CheckSpec {
  name: string
  command: string
  env?: Record<string, string>
}

/** Answers latest versions; `undefined` for unknown packages. */
export interface VersionRegistry {
  latest(ecosystem: Ecosystem, name: string): Promise<string | undefined>
}

/** Read access to a repository's files, through the forge or on disk. */
export interface RepoFiles {
  /** `undefined` when the file does not exist. */
  read(file: string): Promise<string | undefined>
  /** Repository-relative paths of files under `dir` (recursively); absent when listing is not possible. */
  list?(dir: string): Promise<string[]>
}

/** Rewrites manifests and lockfiles of one ecosystem in a writable checkout. */
export interface Bumper {
  ecosystem: Ecosystem
  /** Applies every usage that has a `next` value; rejects when the package manager fails. */
  bump(input: {
    dir: string
    usages: Usage[]
    targets: PackageTarget[]
    runner: CommandRunner
    allowInstallScripts: boolean
    signal?: AbortSignal
  }): Promise<{ bumps: Bump[]; notes: string[] }>
}

/** Runs checks in a checkout. */
export interface Verifier {
  /** Results in the order of `checks`; never rejects for failing checks. */
  verify(input: {
    dir: string
    checks: CheckSpec[]
    runner: CommandRunner
    signal?: AbortSignal
  }): Promise<CheckResult[]>
}

/** Finds release notes for one package bump; `undefined` when it has none. */
export interface ReleaseNotesSource {
  notes(input: {
    dir: string
    package: string
    ecosystem: Ecosystem
    from?: string
    to: string
  }): Promise<ReleaseNotes | undefined>
}

/** A write task for one repository whose checks fail after the bump. */
export interface FixRequest {
  /** `forge:path`. */
  repo: string
  /** What the agent must do: the bumps, the failing output and the release notes. */
  prompt: string
  /** The bump as a binary-safe unified diff against the default branch, applied before the agent runs. */
  patch: string
}

/** Proposes write tasks for repositories whose checks fail after the bump. */
export interface FixProposer {
  /**
   * Proposes one task group with a task per request; returns the group id and each repository's
   * (`forge:path`) task id, or `undefined` when nothing was proposed.
   */
  propose(input: {
    /** Config group of the rollout. */
    group: string
    /** Merge request title, the same for every repository. */
    title: string
    fixes: FixRequest[]
  }): Promise<{ groupId: string; tasks: Record<string, string> } | undefined>
}
