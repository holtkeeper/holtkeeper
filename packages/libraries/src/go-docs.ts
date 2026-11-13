import type { ArchiveFiles } from './types.ts'

/** The doc comment of one Go package, as Markdown. */
export interface GoPackageDoc {
  /** Import path of the package. */
  importPath: string
  /** The file the comment comes from, relative to the module root (`doc.go` when there is one). */
  path: string
  /** `# Package <import path>` followed by the comment, with code blocks fenced. */
  markdown: string
}

const skippedSegment = (segment: string) =>
  segment === 'vendor' ||
  segment === 'testdata' ||
  segment === 'internal' ||
  segment.startsWith('_') ||
  segment.startsWith('.')

const directive = /^[a-z0-9]+:[a-z0-9]/

/** The comment group right above the package clause of a Go file, and the package name. */
export function goPackageComment(source: string): { name: string; doc: string } | undefined {
  const lines = source.split('\n')
  let inBlock = false
  let clause = -1
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/', 2)) {
      inBlock = true
      continue
    }
    if (/^package\s+[\p{L}_]/u.test(trimmed)) {
      clause = index
      break
    }
  }
  if (clause < 0) return undefined
  const name = /^package\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(lines[clause]?.trim() ?? '')?.[1] ?? ''
  const doc: string[] = []
  let at = clause - 1
  const above = lines[at]?.trim() ?? ''
  if (above.endsWith('*/')) {
    const block: string[] = []
    for (; at >= 0; at--) {
      const line = lines[at] ?? ''
      block.unshift(line)
      if (line.includes('/*')) break
    }
    const text = block
      .join('\n')
      .replace(/^\s*\/\*/, '')
      .replace(/\*\/\s*$/, '')
    doc.push(...dedent(text.split('\n')))
  } else
    for (; at >= 0; at--) {
      const match = /^\s*\/\/(.*)$/.exec(lines[at] ?? '')
      if (!match) break
      const text = match[1] ?? ''
      if (directive.test(text) || text.trim().startsWith('+build ')) continue
      doc.unshift(text.startsWith(' ') ? text.slice(1) : text)
    }
  const text = doc.join('\n').trim()
  return { name, doc: text }
}

const dedent = (lines: string[]) => {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(Math.min(cut, line.length - line.trimStart().length)))
}

const listItem = /^([-*+•]|\d+[.)])\s/

/**
 * A Go doc comment as Markdown: `# Heading` lines become `##`, indented spans become fenced code
 * blocks (or list items when they start with a list marker), the rest stays as written.
 */
export function goDocMarkdown(doc: string): string {
  const out: string[] = []
  const lines = doc.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^[ \t]/.test(line) && line.trim()) {
      const span: string[] = []
      while (i < lines.length) {
        const current = lines[i] ?? ''
        if (current.trim() && !/^[ \t]/.test(current)) break
        span.push(current)
        i++
      }
      i--
      let blank = false
      while (span.length && !span.at(-1)?.trim()) {
        span.pop()
        blank = true
      }
      const body = dedent(span)
      if (listItem.test(body[0]?.trim() ?? '')) out.push(...body.map((item) => item.trim()), '')
      else out.push('```go', ...body, '```', ...(blank ? [''] : []))
      continue
    }
    out.push(/^# \S/.test(line) ? `#${line}` : line)
  }
  return out.join('\n').trim()
}

const isDoc = (path: string) => path === 'doc.go' || path.endsWith('/doc.go')

/**
 * Package docs of a Go module from the files of its module zip: one per importable package
 * directory with a doc comment, taken from `doc.go` when it has one, else the first file in path
 * order that has one. Leaves out `internal/`, `vendor/`, `testdata/`, `_` and `.` directories,
 * directories of nested modules, `_test.go` files and `main` packages.
 */
export function goPackageDocs(files: ArchiveFiles, module: string): GoPackageDoc[] {
  const decoder = new TextDecoder()
  const nested = [...files.keys()]
    .filter((path) => path.endsWith('/go.mod'))
    .map((path) => path.slice(0, -'/go.mod'.length))
  const byDir = new Map<string, string[]>()
  for (const path of files.keys()) {
    if (!path.endsWith('.go') || path.endsWith('_test.go')) continue
    const slash = path.lastIndexOf('/')
    const dir = slash < 0 ? '' : path.slice(0, slash)
    if (dir && dir.split('/').some(skippedSegment)) continue
    if (nested.some((root) => dir === root || dir.startsWith(`${root}/`))) continue
    byDir.set(dir, [...(byDir.get(dir) ?? []), path])
  }
  const docs: GoPackageDoc[] = []
  for (const dir of [...byDir.keys()].toSorted()) {
    const paths = (byDir.get(dir) ?? []).toSorted(
      (a, b) => Number(isDoc(b)) - Number(isDoc(a)) || a.localeCompare(b),
    )
    for (const path of paths) {
      const comment = goPackageComment(decoder.decode(files.get(path)))
      if (!comment) continue
      if (comment.name === 'main' || comment.name.endsWith('_test')) break
      if (!comment.doc) continue
      const importPath = dir ? `${module}/${dir}` : module
      docs.push({
        importPath,
        path,
        markdown: `# Package ${importPath}\n\n${goDocMarkdown(comment.doc)}`,
      })
      break
    }
  }
  return docs
}
