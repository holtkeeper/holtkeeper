/** Package ecosystem of a dependency root. */
export type DependencyEcosystem = 'npm' | 'go'

/** What happened to a dependency between the two sides. */
export type DependencyChangeKind = 'added' | 'removed' | 'updated'

/** One side of a direct dependency: the declared range and the resolved version, when known. */
export interface DependencySide {
  /** Range from `package.json`; absent for Go, whose `go.mod` pins a version. */
  range?: string
  /** Version the lockfile resolves (npm) or `go.mod` requires (Go). */
  version?: string
}

/**
 * A dependency a manifest declares that was added, removed or changed. `updated` means the range
 * or the resolved version differs, which includes lockfile-only re-resolutions.
 */
export interface DirectDependencyChange {
  name: string
  change: DependencyChangeKind
  field: 'prod' | 'dev' | 'optional' | 'peer' | 'require' | 'indirect'
  /** Workspace directory relative to the root, `.` for the root; Go: the module path. */
  workspace: string
  /** Absent for `added`. */
  from?: DependencySide
  /** Absent for `removed`. */
  to?: DependencySide
}

/** A package resolved only through other packages, with its versions sorted at each side. */
export interface TransitiveDependencyChange {
  name: string
  change: DependencyChangeKind
  /** Absent for `added`. */
  from?: string[]
  /** Absent for `removed`. */
  to?: string[]
}

/** Dependency changes of one lockfile root or Go module. */
export interface DependencyRoot {
  /** Directory of the lockfile root or Go module, `''` for the repository root. */
  path: string
  ecosystem: DependencyEcosystem
  /** `pnpm`, `bun`, `npm`, `yarn` or `go`; absent when no lockfile was found. */
  manager?: string
  /** Lockfile name relative to `path`, e.g. `pnpm-lock.yaml` or `go.sum`. */
  lockfile?: string
  /** Sorted by workspace, name and field. */
  direct: DirectDependencyChange[]
  /** Sorted by name; packages that are direct dependencies anywhere in the root are left out. */
  transitive: TransitiveDependencyChange[]
  /** `transitive` was cut at a cap; `counts` still count every change. */
  transitiveCapped?: boolean
  counts: {
    added: number
    removed: number
    updated: number
    transitiveAdded: number
    transitiveRemoved: number
    transitiveUpdated: number
  }
  /** What could not be read or parsed; the root still reports what is known. */
  errors: string[]
}

/** Dependency changes between two sides of a repository. */
export interface DependencyDiff {
  /** Sorted by path, then ecosystem. */
  roots: DependencyRoot[]
  /** Roots past the cap that were not computed. */
  skipped: number
  /** The changed file list was incomplete, so roots may be missing. */
  partial: boolean
}

/** The changed files between two sides and a way to read a file at either side. */
export interface DependencyFilesReader {
  files: readonly { oldPath: string; newPath: string; status: string }[]
  /** File content at a side, `undefined` when it does not exist there. May reject. */
  read(path: string, side: 'from' | 'to'): Promise<string | undefined>
}
