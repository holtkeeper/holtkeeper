/**
 * What a component is: a language runtime, a package manager, a service image (database, cache,
 * web server), a base operating system image, any other image, or any other tool.
 */
export type ComponentKind = 'runtime' | 'package-manager' | 'service' | 'os' | 'image' | 'tool'

/**
 * Where a usage was found: a version file (`.nvmrc`, `mise.toml`, `go.mod`, ...), a Dockerfile
 * `FROM`, a compose file, a CI config (images, services and setup actions) or deployment manifests
 * (Helm values, Kubernetes YAML).
 */
export type UsageVia = 'version-file' | 'dockerfile' | 'compose' | 'ci' | 'deploy'

/** One place one repository names a version of one component. */
export interface StackUsage {
  /** Repository path. */
  repo: string
  /** Repository-relative file. */
  file: string
  via: UsageVia
  /** As written: `22-alpine`, `lts`, `3.12`, `postgres:16.4`. */
  declared: string
  /** Comparable version, as precise as written (`22`, `3.12`, `1.23.4`); absent when floating. */
  version?: string
  /** Image tag suffix, e.g. `alpine3.20`, `slim-bookworm`. */
  variant?: string
  /** Full image reference, for image usages. */
  image?: string
}

/** One release line of a product, as endoflife.date describes it. */
export interface LifecycleCycle {
  /** Release line, e.g. `22`, `1.23`, `3.12`, `24.04`. */
  cycle: string
  releaseDate?: string
  /** End of life: a date, `true` when ended without a known date, `false` when none is planned. */
  eol: string | boolean
  /** Long-term support: `true`, or the date the line entered it. */
  lts?: string | boolean
  /** Newest release of the line. */
  latest?: string
}

/** A runtime, package manager, image or tool the analysis follows across the fleet. */
export interface StackComponent {
  /** Stable across records: `node`, `postgres`, `image:ghcr.io/acme/base`. */
  id: string
  name: string
  kind: ComponentKind
  /** Newest release, when known. */
  latest?: string
  /** Newest release of a supported LTS line, for products that have them. */
  latestLts?: string
  /** Where `latest` came from, e.g. `endoflife.date/nodejs`, `npm/pnpm`, `docker.io/library/nginx`. */
  source?: string
  /** Release lines with their support dates, when endoflife.date knows the product. */
  cycles?: LifecycleCycle[]
  usages: StackUsage[]
}

/** What was read from one repository. */
export interface StackRepo {
  path: string
  webUrl?: string
  /** Files usages were read from. */
  files: string[]
  /** Set when the repository could not be read at all. */
  error?: string
  /** Archived repositories are listed but not analyzed. */
  archived?: boolean
}

/** A problem that did not stop the analysis, e.g. an unparsable Dockerfile. */
export interface StackNote {
  repo?: string
  message: string
}

/** Everything the `stack` analysis stores for one group. */
export interface StackData {
  group: string
  /** When versions and lifecycles were looked up (ISO 8601); end of life is judged at this time. */
  checkedAt: string
  /** Days before an end of life that count as soon. */
  soonDays: number
  repos: StackRepo[]
  components: StackComponent[]
  notes: StackNote[]
}
