import type { PathMapping, SourceFile } from './types.ts'

const unquote = (path: string) =>
  path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1).replaceAll('\\"', '"') : path

const strip = (path: string, prefix: string) =>
  path.startsWith(prefix) ? path.slice(prefix.length) : path

/**
 * Splits a `git diff` / `git show` patch into files. Index and mode lines are dropped; the body
 * keeps hunks (or a `GIT binary patch` block) as written.
 */
export function parsePatch(text: string): SourceFile[] {
  const files: SourceFile[] = []
  const blocks = text.split(/^(?=diff --git )/m).filter((block) => block.startsWith('diff --git '))
  for (const block of blocks) {
    const lines = block.split('\n')
    const header = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(lines[0] ?? '')
    let oldPath = header?.[1] ?? ''
    let newPath = header?.[2] ?? oldPath
    let status: SourceFile['status'] = 'modified'
    let binary = false
    let body = 1
    for (; body < lines.length; body++) {
      const line = lines[body]!
      if (line.startsWith('@@') || line === 'GIT binary patch') break
      if (line.startsWith('new file mode')) status = 'added'
      else if (line.startsWith('deleted file mode')) status = 'deleted'
      else if (line.startsWith('rename from ')) {
        oldPath = unquote(line.slice(12))
        status = 'renamed'
      } else if (line.startsWith('rename to ')) newPath = unquote(line.slice(10))
      else if (line.startsWith('--- ') && line !== '--- /dev/null')
        oldPath = strip(unquote(line.slice(4)), 'a/')
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null')
        newPath = strip(unquote(line.slice(4)), 'b/')
      else if (line.startsWith('Binary files ')) binary = true
    }
    if (lines[body] === 'GIT binary patch') binary = true
    if (status === 'added') oldPath = newPath
    if (status === 'deleted') newPath = oldPath
    const diff = lines.slice(body).join('\n').replace(/\n+$/, '')
    files.push({
      oldPath,
      newPath,
      status,
      diff: diff ? `${diff}\n` : '',
      ...(binary ? { binary: true } : {}),
    })
  }
  return files
}

/** Whether a file can be written into a text patch that `git apply` accepts. */
export const patchable = (file: SourceFile) =>
  !file.binary || file.diff.startsWith('GIT binary patch')

/**
 * Renders files as one patch for `git apply`. `blobs` gives the object id of each file's
 * pre-image (by index in `files`) as an `index` line, so `--3way` can merge; files that cannot
 * be applied as text are left out.
 */
export function formatPatch(files: SourceFile[], blobs: Map<number, string> = new Map()): string {
  const parts: string[] = []
  files.forEach((file, index) => {
    if (!patchable(file) || (file.status === 'modified' && !file.diff.trim())) return
    const lines = [`diff --git a/${file.oldPath} b/${file.newPath}`]
    if (file.status === 'added') lines.push('new file mode 100644')
    if (file.status === 'deleted') lines.push('deleted file mode 100644')
    if (file.status === 'renamed')
      lines.push(`rename from ${file.oldPath}`, `rename to ${file.newPath}`)
    const blob = blobs.get(index)
    if (blob && file.status !== 'added')
      lines.push(
        `index ${blob}..${'0'.repeat(blob.length)}${file.status === 'deleted' ? '' : ' 100644'}`,
      )
    if (file.diff.trim() && !file.diff.startsWith('GIT binary patch'))
      lines.push(
        `--- ${file.status === 'added' ? '/dev/null' : `a/${file.oldPath}`}`,
        `+++ ${file.status === 'deleted' ? '/dev/null' : `b/${file.newPath}`}`,
      )
    parts.push(`${lines.join('\n')}\n${file.diff}`)
  })
  return parts.join('')
}

/** Lines added (`+`) and removed (`-`) in a file's hunks, without the marker. */
export function hunkLines(file: SourceFile): {
  added: string[]
  removed: string[]
  context: string[]
} {
  const added: string[] = []
  const removed: string[] = []
  const context: string[] = []
  if (file.binary) return { added, removed, context }
  for (const line of file.diff.split('\n')) {
    if (line.startsWith('@@')) {
      const heading = /^@@[^@]*@@ ?(.*)$/.exec(line)?.[1]
      if (heading) context.push(heading)
    } else if (line.startsWith('+')) added.push(line.slice(1))
    else if (line.startsWith('-')) removed.push(line.slice(1))
    else if (line.startsWith(' ')) context.push(line.slice(1))
  }
  return { added, removed, context }
}

/** Added and removed line counts of a file. */
export function fileStat(file: SourceFile): { additions: number; deletions: number } {
  const { added, removed } = hunkLines(file)
  return { additions: added.length, deletions: removed.length }
}

const keywords = new Set(
  (
    'abstract async await boolean break case catch class const constructor continue default ' +
    'defer delete else enum export extends false final finally func function import interface ' +
    'implements return static string struct switch super this throw true type typeof undefined ' +
    'number null nil package private protected public readonly require self string void while ' +
    'yield from with value values error errors object length index result data string else'
  ).split(' '),
)

const distinctive = (word: string) => /[A-Z_]/.test(word.slice(1)) || word.length >= 7

/**
 * Identifiers the change works on: from removed lines, hunk headings and context, longest
 * first. Common keywords and short names are left out, so the list is good for `git grep -w`.
 */
export function changedSymbols(files: SourceFile[], limit = 30): string[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    if (file.status === 'added') continue
    const { removed, context } = hunkLines(file)
    for (const line of [...removed, ...context])
      for (const word of line.match(/[A-Za-z_$][\w$]{3,}/g) ?? [])
        if (!keywords.has(word.toLowerCase())) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.keys()]
    .toSorted(
      (a, b) =>
        Number(distinctive(b)) - Number(distinctive(a)) ||
        b.length - a.length ||
        a.localeCompare(b),
    )
    .slice(0, limit)
}

const meaningful = (line: string) => line.length >= 12 && /[A-Za-z0-9]/.test(line)

/**
 * Trimmed added lines that identify the change: long enough, not punctuation, and not lines the
 * change also removes (moved code).
 */
export function distinctiveAdditions(files: SourceFile[], limit = 40): string[] {
  const removed = new Set<string>()
  const added = new Set<string>()
  for (const file of files) {
    const lines = hunkLines(file)
    for (const line of lines.removed) removed.add(line.trim())
    for (const line of lines.added) if (meaningful(line.trim())) added.add(line.trim())
  }
  return [...added].filter((line) => !removed.has(line)).slice(0, limit)
}

/** Trimmed removed lines that the change does not add back. */
export function distinctiveRemovals(files: SourceFile[], limit = 40): string[] {
  const removed = new Set<string>()
  const added = new Set<string>()
  for (const file of files) {
    const lines = hunkLines(file)
    for (const line of lines.added) added.add(line.trim())
    for (const line of lines.removed) if (meaningful(line.trim())) removed.add(line.trim())
  }
  return [...removed].filter((line) => !added.has(line)).slice(0, limit)
}

/** Files with their paths rewritten by `mappings`; unmapped paths stay. */
export function remapFiles(files: SourceFile[], mappings: PathMapping[]): SourceFile[] {
  const byPath = new Map(mappings.map((mapping) => [mapping.from, mapping.to]))
  return files.map((file) => ({
    ...file,
    oldPath: byPath.get(file.oldPath) ?? file.oldPath,
    newPath: byPath.get(file.newPath) ?? file.newPath,
  }))
}

/** Rendering-ready hunks of a file, in the shape of report `changes` blocks. */
export function fileDiff(file: SourceFile) {
  const hunks: {
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: { kind: 'context' | 'add' | 'remove'; text: string }[]
  }[] = []
  for (const line of file.diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      hunks.push({
        oldStart: Number(header[1]),
        oldLines: Number(header[2] ?? 1),
        newStart: Number(header[3]),
        newLines: Number(header[4] ?? 1),
        lines: [],
      })
      continue
    }
    const hunk = hunks.at(-1)
    if (!hunk) continue
    if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) hunk.lines.push({ kind: 'remove', text: line.slice(1) })
    else if (line.startsWith(' ')) hunk.lines.push({ kind: 'context', text: line.slice(1) })
  }
  return {
    file: file.newPath,
    status:
      file.status === 'added'
        ? ('added' as const)
        : file.status === 'deleted'
          ? ('deleted' as const)
          : ('modified' as const),
    hunks,
  }
}
