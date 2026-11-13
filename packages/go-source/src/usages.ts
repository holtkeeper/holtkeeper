import { depthDelta, mask } from './mask.ts'

/** One import spec of a Go file. */
export interface GoImport {
  path: string
  /** Name written before the path: an identifier, `_` or `.`; absent when there is none. */
  alias?: string
  /** Identifier the file refers to the package by; absent for blank (`_`) and dot (`.`) imports. */
  name?: string
  /** Position of the opening quote of the path: 1-based line and column, UTF-16 offset. */
  line: number
  column: number
  offset: number
}

/**
 * How a Go file uses a package-level name: a subset of the usages model's kinds (`jsx` and
 * `spread` have no Go counterpart).
 */
export type GoUsageKind =
  | 'call'
  | 'new'
  | 'member'
  | 'type'
  | 'extends'
  | 'reexport'
  | 'reference'
  | 'import'

/** One qualified identifier `pkg.Name` (or one import) tied to the import path it comes from. */
export interface GoUsageSite {
  importPath: string
  /** The exported name; `*` for an `import` site. */
  export: string
  /** Names selected from it, `.`-separated: `pkg.Default.Do` gives `Do`. Only for `member`. */
  member?: string
  kind: GoUsageKind
  /** Field names of a keyed composite literal (`pkg.Config{Addr: …}`), in source order. */
  props?: string[]
  /** Start of `pkg.Name` (of the path for an `import` site): 1-based line and column, UTF-16 offset. */
  line: number
  column: number
  offset: number
}

/** What `scanGoUsages` read from one file. */
export interface GoUsageScan {
  packageName?: string
  imports: GoImport[]
  sites: GoUsageSite[]
}

const identSource = '[\\p{L}_][\\p{L}\\p{N}_]*'
const identStart = /[\p{L}_]/u
const identChar = /[\p{L}\p{N}_]/u
const isIdentChar = (char: string | undefined) => char !== undefined && identChar.test(char)
const isSpace = (char: string | undefined) =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r'

const expressionKeywords = new Set([
  'return',
  'case',
  'go',
  'defer',
  'range',
  'else',
  'if',
  'for',
  'switch',
  'select',
  'var',
  'const',
])

/**
 * The name a package is usually declared with, guessed from its import path: the last element,
 * skipping a `/vN` major suffix, without a `.vN` suffix (`gopkg.in/yaml.v3`), a `go-` prefix or a
 * `-go`/`.go` suffix, with characters an identifier cannot hold removed.
 */
export function defaultPackageName(importPath: string): string {
  const parts = importPath.split('/')
  let last = parts.at(-1) ?? ''
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts.at(-2) ?? last
  last = last
    .replace(/\.v\d+$/, '')
    .replace(/^go-/, '')
    .replace(/[-.]go$/, '')
  return last.replace(/[^\p{L}\p{N}_]/gu, '_').replace(/^(\p{N})/u, '_$1')
}

const lineStartsOf = (text: string) => {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

const positionOf = (starts: number[], offset: number) => {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 }
}

interface ImportBlock {
  from: number
  to: number
}

function readImports(
  code: string,
  structure: string,
  starts: number[],
): { packageName?: string; imports: GoImport[]; blocks: ImportBlock[] } {
  const lines = structure.split('\n')
  const imports: GoImport[] = []
  const blocks: ImportBlock[] = []
  let packageName: string | undefined
  let depth = 0
  const spec = new RegExp(`(?:(${identSource}|\\.|_)[ \\t]+)?(?:"([^"\\n]*)"|\`([^\`]*)\`)`, 'gu')
  const readSpecs = (from: number, to: number) => {
    const text = code.slice(from, to)
    for (const match of text.matchAll(spec)) {
      const path = match[2] ?? match[3] ?? ''
      const alias = match[1]
      const quoted = match[2] !== undefined ? match[2].length + 2 : (match[3] ?? '').length + 2
      const offset = from + (match.index ?? 0) + match[0].length - quoted
      const name = alias === '_' || alias === '.' ? undefined : (alias ?? defaultPackageName(path))
      imports.push({
        path,
        ...(alias ? { alias } : {}),
        ...(name ? { name } : {}),
        ...positionOf(starts, offset),
        offset,
      })
    }
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineStart = starts[index] ?? 0
    if (depth === 0 && trimmed) {
      if (/^package\b/.test(trimmed)) {
        packageName = new RegExp(`^package\\s+(${identSource})`, 'u').exec(trimmed)?.[1]
      } else if (/^import\b/.test(trimmed)) {
        let end = index
        let level = depthDelta(line)
        while (level > 0 && end < lines.length - 1) {
          end++
          level += depthDelta(lines[end] ?? '')
        }
        const to = (starts[end] ?? 0) + (lines[end] ?? '').length
        const from = lineStart + line.indexOf('import') + 'import'.length
        blocks.push({ from: lineStart, to })
        readSpecs(from, to)
        index = end
        continue
      } else if (/^(func|type|var|const)\b/.test(trimmed)) break
    }
    depth += depthDelta(line)
  }
  return { ...(packageName ? { packageName } : {}), imports, blocks }
}

function brackets(structure: string) {
  const enclosing = new Int32Array(structure.length).fill(-1)
  const match = new Int32Array(structure.length).fill(-1)
  const stack: number[] = []
  for (let i = 0; i < structure.length; i++) {
    const char = structure[i]
    enclosing[i] = stack.at(-1) ?? -1
    if (char === '(' || char === '[' || char === '{') stack.push(i)
    else if (char === ')' || char === ']' || char === '}') {
      const open = stack.pop()
      if (open !== undefined) {
        match[open] = i
        match[i] = open
        enclosing[i] = open
      }
    }
  }
  return { enclosing, match }
}

/**
 * Package-level uses in one Go file, found syntactically from its imports: every qualified
 * identifier `pkg.Name` whose `pkg` is an imported package name becomes a site with its kind —
 * `call` for `pkg.F(…)` and `pkg.F[T](…)`, `new` for a composite literal `pkg.T{…}` or `&pkg.T{…}`
 * (its field keys in `props`), `type` in type positions (declarations, parameters, results,
 * fields, `*`, `[]`, `map`, `chan`, `...`, type assertions and type switch cases), `extends` for
 * struct or interface embedding, `reexport` for an alias declaration `type X = pkg.Y`, `member`
 * for `pkg.V.X` or a method expression `pkg.T.M`, `reference` otherwise. Blank and dot imports,
 * and named imports the file never refers to, give one `import` site with export `*`; names
 * brought in by a dot import are not resolved. Standard library imports are scanned like any other;
 * filter them with `isStdlibImport`.
 *
 * `packageNames` maps import paths to their declared package name for imports without an alias;
 * missing paths fall back to `defaultPackageName`. Local names shadowing a package are not
 * detected, and methods called on values a package returned are out of reach without type
 * information. Like `goApi`, this reads gofmt-formatted code (`pkg.T{` with no space marks a
 * composite literal, `pkg.T {` a block).
 */
export function scanGoUsages(
  source: string,
  packageNames?: ReadonlyMap<string, string>,
): GoUsageScan {
  const { structure, code } = mask(source)
  const starts = lineStartsOf(source)
  const { packageName, imports, blocks } = readImports(code, structure, starts)
  for (const item of imports)
    if (!item.alias && packageNames?.has(item.path)) item.name = packageNames.get(item.path)
  const sites: GoUsageSite[] = []
  const byName = new Map<string, GoImport>()
  for (const item of imports) if (item.name) byName.set(item.name, item)

  const { enclosing, match } = brackets(structure)
  const lineStartAt = (offset: number) => structure.lastIndexOf('\n', offset - 1) + 1
  const lineEndAt = (offset: number) => {
    const end = structure.indexOf('\n', offset)
    return end < 0 ? structure.length : end
  }
  const prevNonSpace = (offset: number) => {
    let k = offset - 1
    while (k >= 0 && isSpace(structure[k])) k--
    return k
  }
  const wordEndingAt = (end: number) => {
    let k = end
    while (k >= 0 && isIdentChar(structure[k])) k--
    return structure.slice(k + 1, end + 1)
  }
  const before = (offset: number, length = 240) =>
    structure.slice(Math.max(0, offset - length), offset)
  const braceKind = (open: number) => {
    if (open < 0 || structure[open] !== '{') return undefined
    const head = before(open, 40)
    if (/\bstruct\s*$/.test(head)) return 'struct'
    if (/\binterface\s*$/.test(head)) return 'interface'
    return 'block'
  }
  const isTypeSwitchCase = (offset: number) => {
    if (!/^\s*case\b/.test(structure.slice(lineStartAt(offset), offset))) return false
    const brace = enclosing[offset] ?? -1
    if (brace < 0 || structure[brace] !== '{') return false
    return /\.\(\s*type\s*\)/.test(structure.slice(lineStartAt(brace), brace))
  }
  const signatureHead = new RegExp(
    `\\bfunc\\s*(?:\\([^()]*\\)\\s*)?(?:${identSource}\\s*(?:\\[[^\\]]*\\])?\\s*)?$`,
    'u',
  )
  const isSignatureParen = (open: number): boolean => {
    if (open < 0 || structure[open] !== '(') return false
    if (signatureHead.test(before(open))) return true
    const previous = prevNonSpace(open)
    if (structure[previous] === ')') return isSignatureParen(match[previous] ?? -1)
    const outer = enclosing[open] ?? -1
    return (
      braceKind(outer) === 'interface' &&
      new RegExp(`^\\s*${identSource}\\s*$`, 'u').test(structure.slice(lineStartAt(open), open))
    )
  }
  const inTypeGroup = (offset: number) => {
    const open = enclosing[offset] ?? -1
    return (
      open >= 0 &&
      structure[open] === '(' &&
      /^type\s*$/.test(structure.slice(lineStartAt(open), open).trim())
    )
  }
  const restBlank = (from: number) =>
    /^\s*(?:`\s*`|"\s*")?\s*$/.test(structure.slice(from, lineEndAt(from)))

  const endsStatement = (offset: number) => {
    const char = structure[offset]
    return (
      isIdentChar(char) ||
      char === ')' ||
      char === ']' ||
      char === '}' ||
      char === '"' ||
      char === "'" ||
      char === '`' ||
      ((char === '+' || char === '-') && structure[offset - 1] === char)
    )
  }

  const typeContext = (start: number, end: number): GoUsageKind | undefined => {
    const linePrefix = structure.slice(lineStartAt(start), start)
    if (
      restBlank(end) &&
      (new RegExp(`^\\s*type\\s+${identSource}\\s*(?:\\[[^\\]]*\\])?\\s*=\\s*$`, 'u').test(
        linePrefix,
      ) ||
        (inTypeGroup(start) &&
          new RegExp(`^\\s*${identSource}\\s*(?:\\[[^\\]]*\\])?\\s*=\\s*$`, 'u').test(linePrefix)))
    )
      return 'reexport'
    const outer = braceKind(enclosing[start] ?? -1)
    if (
      (outer === 'struct' || outer === 'interface') &&
      ((/^\s*\*?$/.test(linePrefix) && restBlank(end)) ||
        (/[{;]\s*\*?$/.test(linePrefix) &&
          /^\s*(?:`\s*`|"\s*")?\s*[;}]/.test(structure.slice(end, lineEndAt(end)))))
    )
      return 'extends'
    if (isTypeSwitchCase(start)) return 'type'

    let p = prevNonSpace(start)
    if (structure.slice(p + 1, start).includes('\n') && endsStatement(p)) return undefined
    let star = false
    for (;;) {
      const char = structure[p]
      if (char === '*') {
        star = true
        p = prevNonSpace(p)
      } else if (char === ']') {
        const open = match[p] ?? -1
        if (open < 0) break
        const inside = structure.slice(open + 1, p).trim()
        if (
          structure.slice(Math.max(0, open - 3), open) === 'map' &&
          !isIdentChar(structure[open - 4])
        )
          return 'type'
        if (
          /^[\p{L}\p{N}_.]*$/u.test(inside) &&
          !isIdentChar(structure[open - 1]) &&
          structure[open - 1] !== ')' &&
          structure[open - 1] !== ']'
        )
          return 'type'
        break
      } else if (char === '.' && structure.slice(p - 2, p + 1) === '...') return 'type'
      else if (char === '-' && structure[p - 1] === '<') {
        if (wordEndingAt(prevNonSpace(p - 1)) === 'chan') return 'type'
        break
      } else if (char === 'n' && wordEndingAt(p) === 'chan') return 'type'
      else break
    }
    const char = structure[p]
    if (char === undefined) return undefined
    if (char === '~') return 'type'
    if (char === '|' && braceKind(enclosing[start] ?? -1) === 'interface') return 'type'
    if (isIdentChar(char)) {
      const word = wordEndingAt(p)
      if (expressionKeywords.has(word)) return undefined
      return identStart.test(word[0] ?? '') ? 'type' : undefined
    }
    if (char === ')') return 'type'
    if (char === '(' && structure[p - 1] === '.') return 'type'
    if (char === '(' && /^(?:new|make)$/.test(wordEndingAt(prevNonSpace(p)))) return 'type'
    const typeArguments = (open: number) =>
      structure[open] === '[' &&
      (wordEndingAt(prevNonSpace(open)) === 'map' ||
        isIdentChar(structure[open - 1]) ||
        structure[open - 1] === ']')
    if (char === '[' && typeArguments(p)) return 'type'
    if (char === ',' && typeArguments(enclosing[start] ?? -1)) return 'type'
    if (char === '(' || char === ',') {
      if (isSignatureParen(enclosing[start] ?? -1)) return 'type'
      if (star && char === '(') return 'type'
    }
    return undefined
  }

  const props = (open: number) => {
    const close = match[open] ?? -1
    if (close < 0) return []
    const names: string[] = []
    const key = new RegExp(`(${identSource})\\s*:(?!=)`, 'gu')
    const body = structure.slice(open + 1, close)
    for (const found of body.matchAll(key)) {
      const at = open + 1 + (found.index ?? 0)
      if (enclosing[at] !== open) continue
      const previous = structure[prevNonSpace(at)]
      if (previous !== '{' && previous !== ',') continue
      const name = found[1] ?? ''
      if (!names.includes(name)) names.push(name)
    }
    return names
  }

  const used = new Set<GoImport>()
  if (byName.size) {
    const names = [...byName.keys()].join('|')
    const selector = new RegExp(
      `(?<![\\p{L}\\p{N}_])(?<![^.]\\.)(${names})\\.\\s*(${identSource})`,
      'gu',
    )
    for (const found of structure.matchAll(selector)) {
      const start = found.index ?? 0
      if (blocks.some((block) => start >= block.from && start < block.to)) continue
      const target = byName.get(found[1] ?? '')
      if (!target) continue
      const name = found[2] ?? ''
      const end = start + found[0].length
      used.add(target)
      const site = (kind: GoUsageKind, extra: Partial<GoUsageSite> = {}) =>
        sites.push({
          importPath: target.path,
          export: name,
          ...extra,
          kind,
          ...positionOf(starts, start),
          offset: start,
        })

      const chain: string[] = []
      let k = end
      for (;;) {
        const next = new RegExp(`^\\.\\s*(${identSource})`, 'u').exec(structure.slice(k, k + 200))
        if (!next) break
        chain.push(next[1] ?? '')
        k += next[0].length
      }
      if (chain.length) {
        site('member', { member: chain.join('.') })
        continue
      }
      k = end
      if (structure[k] === '[' && (match[k] ?? -1) > k) k = (match[k] ?? k) + 1
      if (structure[k] === '(') {
        site('call')
        continue
      }
      if (structure[k] === '{') {
        const keys = props(k)
        site('new', keys.length ? { props: keys } : {})
        continue
      }
      site(typeContext(start, k) ?? 'reference')
    }
  }

  for (const item of imports)
    if (!item.name || !used.has(item))
      sites.push({
        importPath: item.path,
        export: '*',
        kind: 'import',
        line: item.line,
        column: item.column,
        offset: item.offset,
      })
  sites.sort((a, b) => a.offset - b.offset)
  return { ...(packageName ? { packageName } : {}), imports, sites }
}

/** Import specs of one Go file, in source order. */
export function parseGoImports(source: string): GoImport[] {
  const { structure, code } = mask(source)
  return readImports(code, structure, lineStartsOf(source)).imports
}
