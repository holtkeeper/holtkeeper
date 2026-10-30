import type { CodeChange } from '@holtkeeper/changes'

/** Package ecosystem in OSV spelling. */
export type Ecosystem = 'npm' | 'Go'

/** How a manifest depends on a library. `indirect` is a Go requirement marked `// indirect`. */
export type UsageKind = 'prod' | 'dev' | 'peer' | 'optional' | 'indirect'

/** One declaration of a library in one manifest of one repository. */
export interface LibraryUsage {
  /** Repository path. */
  repo: string
  /** Manifest file, e.g. `package.json`, `packages/web/package.json`, `go.mod`. */
  manifest: string
  /** Version or range as written, e.g. `^18.2.0`, `v1.9.1`. */
  declared: string
  /** Version a lockfile pins, when one was read. */
  resolved?: string
  /** Version compared with the latest: `resolved`, else the lowest version `declared` admits. */
  version?: string
  kind: UsageKind
}

/** A library the analysis follows across the fleet. */
export interface TrackedLibrary {
  ecosystem: Ecosystem
  name: string
  /** Latest release according to the registry; absent when the registry did not answer. */
  latest?: string
  /** `option`: listed in `libraries`; `auto`: used by at least `minRepos` repositories. */
  reason: 'option' | 'auto'
  usages: LibraryUsage[]
}

/** What was read from one repository. */
export interface FleetRepo {
  path: string
  webUrl?: string
  /** Manifests read: `package.json` files, `go.mod` files and the lockfile, if any. */
  manifests: string[]
  /** Set when the repository could not be read at all; its other fields are then empty. */
  error?: string
  /** Archived repositories are listed but not analyzed. */
  archived?: boolean
}

/** How a repository file is compared with its template. */
export type TemplateMode = 'exact' | 'json-subset' | 'yaml-subset' | 'lines-present'

/**
 * Result of comparing one repository file with one template. `error`: the file or the template
 * could not be compared (unparsable JSON, unreadable template).
 */
export type TemplateStatus = 'identical' | 'drifted' | 'missing' | 'error'

export interface TemplateResult {
  repo: string
  /** File path inside the repository, the template's `path`. */
  file: string
  mode: TemplateMode
  status: TemplateStatus
  /** Human-readable differences, e.g. `engines.node: expected "22.x", found "18.x"`. */
  problems: string[]
  /** Suggested fix targeting the repository, when one could be computed. */
  change?: CodeChange
}

/** A problem that did not stop the analysis, e.g. an unreadable manifest. */
export interface FleetNote {
  repo?: string
  message: string
}

/** Everything the `fleet` analysis stores for one group. */
export interface FleetData {
  group: string
  repos: FleetRepo[]
  libraries: TrackedLibrary[]
  templates: TemplateResult[]
  notes: FleetNote[]
}
