import type { CodeChange } from '@holtkeeper/changes'

import type { DocumentFormat } from './contracts.ts'

/** What a source says about an entity: `definition`, `usage`, `config`, `documentation` or a custom role. */
export type Role = string

/** One value an extractor found: the key as written, where, and its attributes. */
export interface Extracted {
  key: string
  /** 1-based, when the extractor knows it. */
  line?: number
  attrs: Record<string, string>
}

/** A document an occurrence comes from. */
export interface DocumentRef {
  provider: string
  ref: string
  title?: string
  url?: string
}

/** One place an entity appears. File occurrences carry `repo`/`file`, document ones `document`. */
export interface Occurrence {
  /** Id of the source that found it. */
  source: string
  role: Role
  repo?: string
  file?: string
  line?: number
  document?: DocumentRef
  environment?: string
  /** The key as written, when normalization changed it. */
  raw?: string
  attrs: Record<string, string>
}

/** Where a merged attribute value came from. */
export interface Provenance {
  source: string
  role: Role
  repo?: string
  file?: string
  line?: number
  document?: string
}

/** An attribute of an entity: the winning value and, when sources disagree, every distinct one. */
export interface MergedAttr {
  value: string
  from: Provenance
  /** Present only when sources give different values. */
  values?: { value: string; from: Provenance }[]
}

/** A tracked thing (a feature flag, an env variable, ...) identified by its normalized key. */
export interface Entity {
  key: string
  /** Every spelling of the key found in sources, e.g. `FEATURE_NEW_HUB` and `newHub`. */
  labels: string[]
  /** Attributes outside environments, merged by role precedence (definition, documentation, config, usage, others). */
  attrs: Record<string, MergedAttr>
  /** Attributes per environment, from occurrences that have one. */
  environments: Record<string, Record<string, string>>
  occurrences: Occurrence[]
}

export type Severity = 'info' | 'warning' | 'error'

/** A problem a rule found. `id` is stable across runs for the same rule, key and environment. */
export interface Finding {
  id: string
  /** Rule kind, e.g. `unused`. */
  rule: string
  /** Rule id from the definition; the kind unless the definition named it. */
  ruleId: string
  severity: Severity
  key: string
  message: string
  environment?: string
  occurrences: Occurrence[]
}

/** What one source read. */
export interface SourceRead {
  source: string
  kind: string
  role: Role
  repo?: string
  document?: DocumentRef & { version?: number }
  files: number
  bytes: number
  extracted: number
  /** Files left out because a cap was reached. */
  skipped?: number
}

/** A problem that did not stop the run: an unreadable file, an unknown provider, a bad pattern. */
export interface TrackerError {
  source?: string
  output?: string
  repo?: string
  file?: string
  document?: string
  message: string
}

/** Format of a rendered output; `text` is plain text for notifications. */
export type PublicationFormat = DocumentFormat | 'text'

/**
 * Content an output wants written somewhere, planned during analysis and executed later by
 * `publishTracker`. Publications without `provider` (notifications) are not written to documents.
 */
export interface Publication {
  /** Output id. */
  output: string
  kind: string
  provider?: string
  ref?: string
  markerId?: string
  format: PublicationFormat
  content: string
  /** Version of the document read during the run, when the tracker also reads it. */
  expectedVersion?: number
  title?: string
}

/** Everything one tracker run stores. */
export interface TrackerData {
  tracker: { id: string; name: string; label: string }
  generatedAt: string
  entities: Entity[]
  findings: Finding[]
  sourcesRead: SourceRead[]
  errors: TrackerError[]
  publications: Publication[]
  changes: CodeChange[]
}
