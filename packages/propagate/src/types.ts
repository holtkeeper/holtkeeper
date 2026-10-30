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
  /** Fix attempt after which the check ran; 0 is the first run after the bump. */
  attempt: number
}

/** What the agent reported after its last fix attempt. */
export interface AgentReport {
  summary: string
  changes: string[]
  remainingProblems: string[]
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

export type RepoStatus = 'unchanged' | 'skipped' | 'updated' | 'fixed' | 'failed' | 'error'

/** Result of rolling the wave out to one repository. */
export interface RepoOutcome {
  repo: string
  webUrl?: string
  status: RepoStatus
  /** Every target declaration found, bumped or not. */
  usages: Usage[]
  bumps: Bump[]
  /** Latest result of every check. */
  checks: CheckResult[]
  /** Fix attempts made. */
  attempts: number
  agent?: AgentReport
  /** Files changed in the checkout, published or not. */
  changedFiles: string[]
  /** Files the fixer changed besides the bump. */
  fixedFiles: string[]
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
    attempt: number
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

/** Free-form material a fixer gets besides the failing checks: release notes, a source diff, a ticket. */
export interface FixContext {
  title: string
  /** Markdown or plain text; fixers may trim it. */
  text: string
}

/** One fix attempt's input. Nothing in it is specific to package updates. */
export interface FixInput {
  /** Checkout the fixer may change; nothing outside it. */
  dir: string
  /** 1-based. */
  attempt: number
  failing: CheckResult[]
  context: FixContext[]
  /** Task-specific goal and rules, e.g. "do not touch the lockfile". */
  instructions?: string
  signal?: AbortSignal
}

/** Makes failing checks pass. */
export interface Fixer {
  /** `undefined` when the fixer cannot attempt anything; it then is not called again. */
  fix(input: FixInput): Promise<AgentReport | undefined>
}
