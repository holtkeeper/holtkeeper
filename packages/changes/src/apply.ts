import { createHash } from 'node:crypto'

import type { CodeChange, Conflict, Edit, Position } from './types.ts'

/** Character offset of a 1-based position; `undefined` when it lies outside the text. */
export function offsetOf(text: string, { line, column }: Position): number | undefined {
  let offset = 0
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset)
    if (next === -1) return undefined
    offset = next + 1
  }
  const lineEnd = text.indexOf('\n', offset)
  const length = (lineEnd === -1 ? text.length : lineEnd) - offset
  return column - 1 <= length + 1 ? offset + column - 1 : undefined
}

type ReplaceEdit = Extract<Edit, { kind: 'replace' }>

/**
 * Applies `replace` edits to one file's text. Edits are applied from the end so earlier offsets
 * stay valid; each must find its `oldText` at its range, and edits must not overlap.
 */
export function applyReplacements(
  text: string,
  edits: readonly ReplaceEdit[],
): { text: string } | { error: string } {
  const located = edits.map((edit) => ({
    edit,
    start: offsetOf(text, edit.range.start),
    end: offsetOf(text, edit.range.end),
  }))
  for (const { edit, start, end } of located) {
    if (start === undefined || end === undefined || end < start)
      return { error: 'range is outside the file' }
    if (text.slice(start, end) !== edit.oldText)
      return { error: 'the file changed since the suggestion was made' }
  }
  const ordered = located.toSorted((a, b) => (b.start ?? 0) - (a.start ?? 0))
  for (let i = 1; i < ordered.length; i++) {
    const later = ordered[i - 1]
    const earlier = ordered[i]
    if (later && earlier && (earlier.end ?? 0) > (later.start ?? 0))
      return { error: 'edits overlap' }
  }
  let result = text
  for (const { edit, start, end } of ordered) {
    result = result.slice(0, start) + edit.newText + result.slice(end)
  }
  return { text: result }
}

/** Reads files for `planChanges`; local disk, a forge branch or memory. */
export interface FileAccess {
  /** `undefined` when the file does not exist. */
  read(file: string): Promise<string | undefined>
  /**
   * Raw bytes, for `write-binary` edits; `undefined` when the file does not exist. Without it the
   * text from `read` is encoded as UTF-8, which only matches the real bytes of text files.
   */
  readBytes?(file: string): Promise<Uint8Array | undefined>
}

/** Options of `planChanges`. */
export interface PlanOptions {
  /**
   * Content of a stored artifact, for `write-binary` edits that reference one instead of carrying
   * `base64`; `undefined` when it is gone, which makes the change conflict.
   */
  resolveArtifact?(id: string): Promise<Uint8Array | undefined> | Uint8Array | undefined
}

export interface PlannedFile {
  file: string
  /** New text. `undefined` deletes the file — unless `bytes` is set. */
  content: string | undefined
  /** New contents of a file written by a `write-binary` edit; `content` is then `undefined`. */
  bytes?: Uint8Array
  /** Whether the file existed before the changes. */
  existed: boolean
}

export interface ChangePlan {
  files: PlannedFile[]
  applied: string[]
  conflicts: Conflict[]
}

interface FileState {
  existed: boolean
  /** Text before any change; replace ranges always refer to this text. */
  original: string | undefined
  /** Raw bytes before any change, once a binary edit needed them. */
  originalBytes?: Uint8Array
  /** Replace edits accepted so far, applied together on `original`. */
  replaces: ReplaceEdit[]
  /** Set when a change wrote, created or deleted the whole file; later replaces apply to it. */
  whole?: { content: string | undefined; bytes?: Uint8Array }
}

const current = (state: FileState): string | undefined => {
  if (state.whole) return state.whole.content
  if (state.original === undefined) return undefined
  const result = applyReplacements(state.original, state.replaces)
  return 'text' in result ? result.text : state.original
}

const exists = (state: FileState) =>
  state.whole ? state.whole.content !== undefined || state.whole.bytes !== undefined : state.existed

const currentBytes = (state: FileState): Uint8Array | undefined => {
  if (state.whole?.bytes) return state.whole.bytes
  if (!state.whole && state.replaces.length === 0 && state.originalBytes) return state.originalBytes
  const text = current(state)
  return text === undefined ? undefined : new TextEncoder().encode(text)
}

/** Lowercase hex SHA-256 of `bytes`, the hash `write-binary` edits compare. */
export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

type BinaryEdit = Extract<Edit, { kind: 'write-binary' }>

async function binaryContent(edit: BinaryEdit, options: PlanOptions): Promise<Uint8Array | string> {
  let bytes: Uint8Array | undefined
  if (edit.base64 !== undefined) bytes = new Uint8Array(Buffer.from(edit.base64, 'base64'))
  else if (edit.artifact !== undefined) bytes = await options.resolveArtifact?.(edit.artifact)
  if (!bytes) return 'the binary content is not available'
  if (bytes.byteLength !== edit.bytes) return 'the binary content does not match its size'
  return bytes
}

/**
 * Computes new file contents for a set of changes without writing anything. Replace ranges refer
 * to the files as they were when analyzed, so several independent changes to one file combine;
 * a change that does not apply — stale text, overlapping another selected change, creating an
 * existing file, a binary file whose hash moved on — is skipped and reported, the rest still apply.
 */
export async function planChanges(
  changes: readonly CodeChange[],
  files: FileAccess,
  options: PlanOptions = {},
): Promise<ChangePlan> {
  const states = new Map<string, FileState>()
  const load = async (file: string, binary: boolean): Promise<FileState> => {
    let state = states.get(file)
    if (!state) {
      if (binary && files.readBytes) {
        const bytes = await files.readBytes(file)
        state = {
          existed: bytes !== undefined,
          original: bytes && new TextDecoder().decode(bytes),
          ...(bytes ? { originalBytes: bytes } : {}),
          replaces: [],
        }
      } else {
        const original = await files.read(file)
        state = { existed: original !== undefined, original, replaces: [] }
      }
      states.set(file, state)
    }
    if (
      binary &&
      state.existed &&
      !state.originalBytes &&
      !state.whole &&
      state.replaces.length === 0 &&
      files.readBytes
    ) {
      const bytes = await files.readBytes(file)
      if (bytes) state.originalBytes = bytes
    }
    return state
  }
  const applied: string[] = []
  const conflicts: Conflict[] = []
  const touched = new Set<string>()

  for (const change of changes) {
    const staged = new Map<string, FileState>()
    let conflict: Conflict | undefined
    const fail = (file: string, reason: string) => {
      conflict = { changeId: change.id, file, reason }
    }

    for (const [file, edits] of Map.groupBy(change.edits, (edit) => edit.file)) {
      const binaries = edits.filter((e): e is BinaryEdit => e.kind === 'write-binary')
      const state = staged.get(file) ?? { ...(await load(file, binaries.length > 0)) }
      const creates = edits.filter((e) => e.kind === 'create')
      const deletes = edits.filter((e) => e.kind === 'delete')
      const replaces = edits.filter((e): e is ReplaceEdit => e.kind === 'replace')
      const content = current(state)

      if (binaries.length) {
        const [edit] = binaries
        if (!edit || edits.length > 1)
          fail(file, 'a binary write cannot be combined with other edits')
        else if (edit.previousSha256 === undefined && exists(state))
          fail(file, 'file already exists')
        else if (edit.previousSha256 !== undefined && !exists(state)) fail(file, 'file not found')
        else if (
          edit.previousSha256 !== undefined &&
          sha256Hex(currentBytes(state) ?? new Uint8Array()) !== edit.previousSha256.toLowerCase()
        )
          fail(file, 'the file changed since the suggestion was made')
        else {
          const bytes = await binaryContent(edit, options)
          if (typeof bytes === 'string') fail(file, bytes)
          else staged.set(file, { ...state, whole: { content: undefined, bytes } })
        }
      } else if (state.whole?.bytes) {
        fail(file, 'the file is binary')
      } else if (creates.length) {
        if (content !== undefined) fail(file, 'file already exists')
        else staged.set(file, { ...state, whole: { content: creates.at(-1)?.newText } })
      } else if (deletes.length) {
        if (content === undefined || content !== deletes[0]?.oldText) {
          fail(file, 'the file changed since the suggestion was made')
        } else staged.set(file, { ...state, whole: { content: undefined } })
      } else if (content === undefined) {
        fail(file, 'file not found')
      } else if (state.whole) {
        const result = applyReplacements(content, replaces)
        if ('error' in result) fail(file, result.error)
        else staged.set(file, { ...state, whole: { content: result.text } })
      } else {
        const combined = [...state.replaces, ...replaces]
        const result = applyReplacements(state.original ?? '', combined)
        if ('error' in result) fail(file, result.error)
        else staged.set(file, { ...state, replaces: combined })
      }
      if (conflict) break
    }

    if (conflict) {
      conflicts.push(conflict)
      continue
    }
    for (const [file, state] of staged) {
      states.set(file, state)
      touched.add(file)
    }
    applied.push(change.id)
  }

  return {
    files: [...touched].map((file) => {
      const state = states.get(file)
      const bytes = state?.whole?.bytes
      return {
        file,
        content: state ? current(state) : undefined,
        ...(bytes ? { bytes } : {}),
        existed: state?.existed ?? false,
      }
    }),
    applied,
    conflicts,
  }
}
