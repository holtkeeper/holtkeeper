/** Representation of a document body. `storage` is Confluence's XHTML storage format. */
export type DocumentFormat = 'storage' | 'markdown' | 'html'

/** A document as read from its source. */
export interface SourceDocument {
  /** The ref the document was read by. */
  ref: string
  title: string
  /** Current version number; pass it as `expectedVersion` to detect concurrent edits. */
  version: number
  /** Link a person can open. */
  url: string
  format: DocumentFormat
  body: string
}

/**
 * Reads documents. Structurally identical to `DocumentSource` of `@holtkeeper/tracker`, defined
 * here until that package exports it.
 */
export interface DocumentSource {
  readonly provider: string
  /** Reads the document behind `ref` (an id or a link the provider understands). */
  read(ref: string): Promise<SourceDocument>
}

/** One managed section of a document, delimited by markers named `markerId`; `''` is the whole document. */
export interface ReplaceSectionInput {
  markerId: string
  content: string
  format: DocumentFormat
  /** When set and the document is at another version, nothing is written and the call rejects. */
  expectedVersion?: number
  /** Version comment stored with the new version. */
  message?: string
}

/** Outcome of `replaceSection`: the document's version after the call. */
export interface ReplaceSectionResult {
  version: number
  url: string
  /** `false` when the section already had this content and no new version was written. */
  changed: boolean
}

/**
 * Writes managed sections into documents without touching anything outside them. Structurally
 * identical to `DocumentSink` of `@holtkeeper/tracker`, defined here until that package exports it.
 */
export interface DocumentSink {
  readonly provider: string
  replaceSection(ref: string, input: ReplaceSectionInput): Promise<ReplaceSectionResult>
}
