import type { RepoRef } from '@holtkeeper/forge'

/** 1-based line and column of a position in a text file. */
export interface Position {
  line: number
  column: number
}

export interface Range {
  start: Position
  /** Exclusive. */
  end: Position
}

/**
 * One file operation. `replace` carries the text it expects to replace, so applying a change to a
 * file that moved on is detected instead of corrupting it.
 */
export type Edit =
  | { kind: 'replace'; file: string; range: Range; oldText: string; newText: string }
  | { kind: 'create'; file: string; newText: string }
  | { kind: 'delete'; file: string; oldText: string }
  /**
   * Writes a binary file (an optimized image, a generated variant). `previousSha256` is the hash
   * of the content it replaces, or absent when the file must not exist yet; `artifact` names the
   * stored blob when `base64` is left out to keep analysis data small.
   */
  | {
      kind: 'write-binary'
      file: string
      bytes: number
      base64?: string
      artifact?: string
      previousSha256?: string
    }

/**
 * A proposed code change someone can accept: a lint autofix, a rename to the project convention,
 * a generated test, a dependency bump. Every analysis that suggests edits uses this shape, so one
 * UI and one applier handle all of them.
 */
export interface CodeChange {
  /** Stable for the same suggestion across runs, so accepted or dismissed changes are recognized. */
  id: string
  title: string
  description?: string
  /** `safe` changes keep behavior (formatting, autofixes marked safe); `review` ones need a look. */
  confidence: 'safe' | 'review'
  /** Tool that proposed it, e.g. `oxlint`, `conventions`, `claude`. */
  source: string
  /**
   * Repository the edits belong to, when it is not the analyzed one — e.g. fleet-wide analyses
   * that suggest changes in many repositories. Accepting opens one merge request per target.
   */
  target?: RepoRef
  edits: Edit[]
}

/** A file's lines in a unified-diff hunk. */
export interface DiffLine {
  kind: 'context' | 'add' | 'remove'
  text: string
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

/** How a change looks per file, ready for rendering. */
export interface FileDiff {
  file: string
  /** `binary` files have no hunks; `binary` carries their sizes instead. */
  status: 'modified' | 'added' | 'deleted' | 'binary'
  hunks: DiffHunk[]
  /** Sizes in bytes of a binary file; `before` is absent when unknown or the file is new. */
  binary?: { before?: number; after: number }
}

/** Why a change could not be applied to the current contents. */
export interface Conflict {
  changeId: string
  file: string
  reason: string
}
