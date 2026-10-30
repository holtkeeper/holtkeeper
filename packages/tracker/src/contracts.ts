/** Body formats documents are read and written in; `storage` is Confluence's XHTML storage format. */
export type DocumentFormat = 'storage' | 'markdown' | 'html'

/** One document as a `DocumentSource` returns it. */
export interface DocumentContent {
  /** The ref the document was read by. */
  ref: string
  title: string
  /** Version the body belongs to; publishing with it as `expectedVersion` detects concurrent edits. */
  version: number
  url: string
  format: DocumentFormat
  body: string
}

/**
 * Read access to documents of one provider (Confluence, a wiki, ...). `ref` is whatever the
 * provider uses to address a page: an id or a URL. Rejects when the document cannot be read.
 */
export interface DocumentSource {
  /** Provider name trackers refer to, e.g. `confluence`. */
  readonly provider: string
  read(ref: string): Promise<DocumentContent>
}

/** What `DocumentSink.replaceSection` writes. */
export interface SectionInput {
  /**
   * Marker pair the content goes between, e.g. `holtkeeper:flags`; how markers look is up to the
   * provider. An empty string replaces the whole body of the document.
   */
  markerId: string
  content: string
  format: DocumentFormat
  /**
   * Write only when the document is still at this version; otherwise reject with an error that
   * `isVersionConflict` recognizes (e.g. a `DocumentVersionConflictError`).
   */
  expectedVersion?: number
  /** Change note, where the provider keeps one. */
  message?: string
}

/** Outcome of a write. `changed` is false when the section already had this content. */
export interface SectionResult {
  version: number
  url: string
  changed: boolean
}

/** Write access to documents of one provider. Rejects when the document cannot be written. */
export interface DocumentSink {
  readonly provider: string
  replaceSection(ref: string, input: SectionInput): Promise<SectionResult>
}

/** Thrown by sinks when `expectedVersion` no longer matches the document. */
export class DocumentVersionConflictError extends Error {
  readonly code = 'version_conflict'
  readonly expectedVersion: number | undefined
  readonly actualVersion: number | undefined

  constructor(message: string, versions: { expected?: number; actual?: number } = {}) {
    super(message)
    this.name = 'DocumentVersionConflictError'
    this.expectedVersion = versions.expected
    this.actualVersion = versions.actual
  }
}

/**
 * Whether a sink error means the document moved on: a `DocumentVersionConflictError`, or any
 * error with `code` `version_conflict`/`conflict` or HTTP `status` 409.
 */
export function isVersionConflict(error: unknown): boolean {
  if (error instanceof DocumentVersionConflictError) return true
  if (typeof error !== 'object' || error === null) return false
  const { code, status, name } = error as { code?: unknown; status?: unknown; name?: unknown }
  return (
    code === 'version_conflict' ||
    code === 'conflict' ||
    status === 409 ||
    name === 'DocumentVersionConflictError'
  )
}
