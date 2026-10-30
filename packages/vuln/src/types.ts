export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown'

/** A resolved dependency, named the way its ecosystem names it. */
export interface PackageRef {
  name: string
  version: string
  /** OSV ecosystem name: `npm`, `Go`, `PyPI`, `Maven`, `crates.io`, ... */
  ecosystem: string
}

/** One vulnerability affecting one package version found in one source file. */
export interface Finding {
  /** Primary advisory id, usually a GHSA or OSV id. */
  id: string
  /** Other ids of the same advisory, such as CVE numbers. */
  aliases: string[]
  summary: string
  severity: Severity
  url: string
  package: PackageRef
  /** Lockfile or manifest the package was found in, relative to the scanned directory. */
  source: string
  /** Versions that fix the advisory for the affected version, lowest first. */
  fixedVersions: string[]
}

export interface ScanOptions {
  signal?: AbortSignal
}

/** Finds vulnerable dependencies in a project checkout. */
export interface Scanner {
  readonly name: string
  scan(dir: string, options?: ScanOptions): Promise<Finding[]>
}

export interface FixRequest {
  /** Project checkout the source path is relative to. */
  dir: string
  /** Source file the findings belong to; every finding has this `source`. */
  source: string
  findings: Finding[]
  signal?: AbortSignal
}

export interface FixResult {
  /** Files written by the fixer, relative to `dir`. */
  changedFiles: string[]
  /** Ids of findings the fixer expects to be gone. A rescan has the final say. */
  fixed: string[]
  /** Human-readable remarks for the report, such as why something was skipped. */
  notes: string[]
}

/**
 * Changes a project so that some findings go away. Fixers are tried in order for each source
 * file; findings one fixer leaves unfixed are offered to the next fixer that supports the file.
 */
export interface Fixer {
  readonly name: string
  /** Whether this fixer can handle the given source file (a path relative to the project). */
  supports(source: string): boolean
  fix(request: FixRequest): Promise<FixResult>
}
