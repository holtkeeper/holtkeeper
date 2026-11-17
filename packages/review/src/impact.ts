import { join, posix } from 'node:path'

import { Lang, parse, type SgNode } from '@ast-grep/napi'
import { listFiles } from '@holtkeeper/agent-tools'

import type { FileScope } from './scope.ts'

export interface ImpactOptions {
  /** Checkout at the merge request head. */
  dir: string
  /** Files in scope of the review, with hunks and `lines` (new-side changed lines). */
  files: readonly FileScope[]
  signal?: AbortSignal
  /** Cap of the section in characters; default 8000. */
  maxChars?: number
}

/** What a changed declaration is; members of classes are `method`, `getter`, `setter`, `field`. */
type DeclarationKind =
  | 'function'
  | 'class'
  | 'method'
  | 'getter'
  | 'setter'
  | 'field'
  | 'const'
  | 'interface'
  | 'type'
  | 'enum'

interface Declaration {
  path: string
  name: string
  /** `Class.member` for members, the name otherwise. */
  label: string
  kind: DeclarationKind
  start: number
  end: number
  /** Changed new-side lines attributed to this declaration (members' lines are not the class's). */
  changed: number[]
}

interface Reference {
  path: string
  line: number
  code: string
  test: boolean
  write: boolean
}

const DEFAULT_MAX_CHARS = 8000
const MAX_SYMBOLS = 25
const MAX_LINES_PER_SYMBOL = 8
const MAX_TEST_LINES_PER_SYMBOL = 3
const MIN_NAME_LENGTH = 4
const MAX_REFERENCES = 60
const MAX_CODE_LENGTH = 160

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/
const STORY_FILE = /\.stor(y|ies)\.[cm]?[jt]sx?$/
const SCRIPT_SUFFIX = /\.[cm]?[jt]sx?$/
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u

const REFERENCE_KINDS = new Set([
  'identifier',
  'type_identifier',
  'property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
])
// A bare `pending` is rarely the member `pending`, so members only match property positions.
const MEMBER_REFERENCE_KINDS = new Set([
  'property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
])
const DEFINITION_KINDS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'variable_declarator',
  'method_definition',
  'method_signature',
  'abstract_method_signature',
  'public_field_definition',
  'field_definition',
  'property_signature',
])
const PRIORITY: Record<DeclarationKind, number> = {
  method: 0,
  getter: 0,
  setter: 0,
  field: 0,
  function: 0,
  const: 1,
  class: 2,
  interface: 3,
  type: 3,
  enum: 3,
}
const ACCESSOR_KINDS = new Set<DeclarationKind>(['field', 'getter', 'setter'])

/** Whether `path` is a test file: under `__tests__/` or named `*.test.*` / `*.spec.*`. */
const isTestFile = (path: string) => TEST_FILE.test(path)

function langOf(path: string): Lang | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tsx')) return Lang.Tsx
  if (/\.[cm]?ts$/.test(lower)) return Lang.TypeScript
  if (/\.([cm]?js|jsx)$/.test(lower)) return Lang.JavaScript
  return undefined
}

function linesOf(node: SgNode): { start: number; end: number } {
  const { start, end } = node.range()
  return { start: start.line + 1, end: end.line + 1 }
}

function nameOf(node: SgNode): string | undefined {
  const name = (node.field('name') ?? node.field('property'))?.text()
  return name && IDENTIFIER.test(name) ? name : undefined
}

function memberKind(node: SgNode): DeclarationKind | undefined {
  const kind = String(node.kind())
  if (kind === 'public_field_definition' || kind === 'field_definition') return 'field'
  if (kind !== 'method_definition') return undefined
  const tokens = new Set(node.children().map((child) => String(child.kind())))
  if (tokens.has('get')) return 'getter'
  if (tokens.has('set')) return 'setter'
  return 'method'
}

const TOP_LEVEL_KINDS: Record<string, DeclarationKind> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
}

/**
 * Declarations of one parsed file whose range holds changed lines. A class owns only the changed
 * lines outside its members, so a change inside a method lists the method, not the class;
 * constructor changes count for the class.
 */
function changedDeclarations(path: string, root: SgNode, changed: Set<number>): Declaration[] {
  const found: Declaration[] = []
  const linesIn = (start: number, end: number) =>
    [...changed].filter((line) => line >= start && line <= end).toSorted((a, b) => a - b)
  for (const statement of root.children()) {
    const exported = statement.kind() === 'export_statement'
    const node = exported ? (statement.field('declaration') ?? statement) : statement
    const range = linesOf(statement)
    const kind = TOP_LEVEL_KINDS[String(node.kind())]
    if (kind) {
      const name = nameOf(node)
      if (!name) continue
      const own = new Set(linesIn(range.start, range.end))
      if (kind === 'class') {
        for (const member of node.field('body')?.children() ?? []) {
          const memberName = nameOf(member)
          const type = memberKind(member)
          if (!type || !memberName || memberName === 'constructor') continue
          const { start, end } = linesOf(member)
          const lines = linesIn(start, end)
          for (const line of lines) own.delete(line)
          if (lines.length > 0)
            found.push({
              path,
              name: memberName,
              label: `${name}.${memberName}`,
              kind: type,
              start,
              end,
              changed: lines,
            })
        }
      }
      if (own.size > 0) found.push({ path, name, label: name, kind, ...range, changed: [...own] })
      continue
    }
    if (node.kind() !== 'lexical_declaration') continue
    for (const declarator of node.children()) {
      if (declarator.kind() !== 'variable_declarator') continue
      const name = nameOf(declarator)
      const value = String(declarator.field('value')?.kind() ?? '')
      const isFunction = value === 'arrow_function' || value === 'function_expression'
      if (!name || (!exported && !isFunction)) continue
      const { start, end } = linesOf(declarator)
      const lines = linesIn(Math.min(start, range.start), end)
      if (lines.length > 0)
        found.push({
          path,
          name,
          label: name,
          kind: isFunction ? 'function' : 'const',
          start: range.start,
          end,
          changed: lines,
        })
    }
  }
  return found
}

function isDefinitionName(node: SgNode): boolean {
  const parent = node.parent()
  if (!parent || !DEFINITION_KINDS.has(String(parent.kind()))) return false
  return (parent.field('name') ?? parent.field('property'))?.id() === node.id()
}

function inImport(node: SgNode): boolean {
  for (let current = node.parent(); current; current = current.parent())
    if (current.kind() === 'import_statement') return true
  return false
}

/** Whether a property reference assigns, updates or deletes the member it names. */
function isWrite(node: SgNode): boolean {
  const member = node.parent()
  if (member?.kind() !== 'member_expression') return false
  const user = member.parent()
  if (!user) return false
  const kind = String(user.kind())
  if (kind === 'assignment_expression' || kind === 'augmented_assignment_expression')
    return user.field('left')?.id() === member.id()
  if (kind === 'update_expression') return true
  return kind === 'unary_expression' && user.text().startsWith('delete')
}

function clip(text: string): string {
  const flat = text.trim().replaceAll(/\s+/g, ' ')
  return flat.length > MAX_CODE_LENGTH ? `${flat.slice(0, MAX_CODE_LENGTH - 1)}…` : flat
}

/** Every script file of the checkout, read once and parsed on demand. */
class Checkout {
  readonly dir: string
  private readonly texts = new Map<string, string>()
  private readonly roots = new Map<string, SgNode | null>()

  constructor(dir: string) {
    this.dir = dir
  }

  async load(signal: AbortSignal | undefined): Promise<void> {
    const paths = await listFiles(this.dir, {
      extensions: SCRIPT_EXTENSIONS,
      ...(signal ? { signal } : {}),
    })
    const texts = new Map<string, string>()
    const read = async (path: string) => {
      signal?.throwIfAborted()
      try {
        const file = Bun.file(join(this.dir, path))
        if (file.size > 1_000_000) return
        const text = await file.text()
        if (!text.slice(0, 8000).includes('\0')) texts.set(path, text)
      } catch {
        // An unreadable file has no references to offer.
      }
    }
    // Batches keep large checkouts under the open-file limit.
    for (let at = 0; at < paths.length; at += 64)
      // oxlint-disable-next-line no-await-in-loop
      await Promise.all(paths.slice(at, at + 64).map(read))
    for (const path of paths) {
      const text = texts.get(path)
      if (text !== undefined) this.texts.set(path, text)
    }
  }

  paths(): string[] {
    return [...this.texts.keys()]
  }

  text(path: string): string | undefined {
    return this.texts.get(path)
  }

  root(path: string): SgNode | undefined {
    if (!this.roots.has(path)) {
      const text = this.texts.get(path)
      const lang = langOf(path)
      let root: SgNode | null = null
      try {
        if (text !== undefined && lang) root = parse(lang, text).root()
      } catch {
        root = null
      }
      this.roots.set(path, root)
    }
    return this.roots.get(path) ?? undefined
  }
}

type Lookup = { skipped: string } | { references: Reference[] }

function findReferences(
  checkout: Checkout,
  declaration: Declaration,
  signal: AbortSignal | undefined,
): Lookup {
  const { name } = declaration
  if (name.length < MIN_NAME_LENGTH)
    return { skipped: `name shorter than ${MIN_NAME_LENGTH} characters, not searched` }
  const member = ['method', 'getter', 'setter', 'field'].includes(declaration.kind)
  const kinds = member ? MEMBER_REFERENCE_KINDS : REFERENCE_KINDS
  const word = new RegExp(
    `(^|[^\\p{L}\\p{N}_$])${name.replaceAll('$', '\\$')}($|[^\\p{L}\\p{N}_$])`,
    'u',
  )
  const exact = `^${name.replaceAll('$', '\\$')}$`
  const found = new Map<string, Reference>()
  for (const path of checkout.paths()) {
    signal?.throwIfAborted()
    const text = checkout.text(path)
    if (text === undefined || !word.test(text)) continue
    const root = checkout.root(path)
    if (!root) continue
    const lines = text.split(/\r?\n/)
    for (const node of root.findAll({ rule: { regex: exact } })) {
      if (!kinds.has(String(node.kind())) || isDefinitionName(node) || inImport(node)) continue
      const line = linesOf(node).start
      if (path === declaration.path && line >= declaration.start && line <= declaration.end)
        continue
      const key = `${path}:${line}`
      const write = isWrite(node)
      const known = found.get(key)
      if (known) known.write ||= write
      else
        found.set(key, {
          path,
          line,
          code: clip(lines[line - 1] ?? ''),
          test: isTestFile(path),
          write,
        })
    }
    if (found.size > MAX_REFERENCES)
      return { skipped: `more than ${MAX_REFERENCES} reference lines, too common to list` }
  }
  return {
    references: [...found.values()].toSorted((a, b) =>
      a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1,
    ),
  }
}

function ranges(lines: readonly number[]): string {
  const parts: string[] = []
  let first = lines[0]
  let last = first
  for (const line of [...lines.slice(1), undefined]) {
    if (line !== undefined && last !== undefined && line === last + 1) {
      last = line
      continue
    }
    if (first !== undefined && last !== undefined)
      parts.push(first === last ? `${first}` : `${first}–${last}`)
    first = line
    last = line
  }
  return parts.join(', ')
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function listing(title: string, references: readonly Reference[], max: number): string[] {
  if (references.length === 0) return []
  const shown = references
    .slice(0, max)
    .map((reference) => `- ${reference.path}:${reference.line}: ${reference.code}`)
  const more = references.length > max ? [`- … ${references.length - max} more`] : []
  return [`${title} (${references.length}):`, ...shown, ...more]
}

function renderSymbol(declaration: Declaration, lookup: Lookup): string {
  const lines = [
    `### ${declaration.path} › ${declaration.label} (${declaration.kind})`,
    `Changed lines: ${ranges(declaration.changed)}.`,
  ]
  if ('skipped' in lookup) return [...lines, `Skipped: ${lookup.skipped}.`].join('\n')
  const { references } = lookup
  if (references.length === 0)
    return [...lines, 'No references outside the declaration.'].join('\n')
  const tests = references.filter((reference) => reference.test)
  const code = references.filter((reference) => !reference.test)
  const files = new Set(references.map((reference) => reference.path)).size
  lines.push(
    `${plural(references.length, 'reference line')} in ${plural(files, 'file')}, ${tests.length} in tests.`,
  )
  if (ACCESSOR_KINDS.has(declaration.kind)) {
    const writes = code.filter((reference) => reference.write)
    const reads = code.filter((reference) => !reference.write)
    const writeBudget = Math.min(writes.length, Math.max(MAX_LINES_PER_SYMBOL - reads.length, 4))
    lines.push(
      ...listing('Writes', writes, writeBudget),
      ...listing('Reads', reads, MAX_LINES_PER_SYMBOL - Math.min(writeBudget, writes.length)),
    )
  } else lines.push(...listing('References', code, MAX_LINES_PER_SYMBOL))
  lines.push(...listing('In tests', tests, MAX_TEST_LINES_PER_SYMBOL))
  return lines.join('\n')
}

const IMPORT_SOURCE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm

function withoutScriptSuffix(path: string): string {
  return path.replace(SCRIPT_SUFFIX, '')
}

/** Whether an import specifier written in `from` points at the module `target` (no extension). */
function pointsAt(specifier: string, from: string, target: string): boolean {
  const candidates = [target, target.endsWith('/index') ? target.slice(0, -6) : undefined]
  if (specifier.startsWith('.')) {
    const resolved = withoutScriptSuffix(
      posix.normalize(posix.join(posix.dirname(from), specifier)),
    )
    return candidates.includes(resolved)
  }
  // Path aliases (`@/widgets/Widget`, `~/widgets/Widget`) end with the target's own path.
  const rest = specifier.replace(/^[@~#]\//, '')
  if (!rest.includes('/')) return false
  return candidates.some((candidate) => candidate === rest || candidate?.endsWith(`/${rest}`))
}

/** Test files that import `source` or are named after it next to it. */
function testsOf(checkout: Checkout, source: string): { path: string; why: string }[] {
  const target = withoutScriptSuffix(source)
  const folder = posix.dirname(source)
  const stem = posix.basename(target)
  const found: { path: string; why: string }[] = []
  for (const path of checkout.paths()) {
    if (!isTestFile(path) || path === source) continue
    const text = checkout.text(path) ?? ''
    const imports = [...text.matchAll(IMPORT_SOURCE)].some((match) =>
      pointsAt(match[1] ?? '', path, target),
    )
    if (imports) {
      found.push({ path, why: 'imports it' })
      continue
    }
    const testFolder = posix.dirname(path)
    const name = posix.basename(path)
    const nearby =
      testFolder === folder ||
      testFolder === posix.join(folder, '__tests__') ||
      testFolder === posix.join(posix.dirname(folder), '__tests__')
    const named =
      name.startsWith(`${stem}.`) || (testFolder.endsWith('__tests__') && name.startsWith(stem))
    if (nearby && named) found.push({ path, why: 'named after it' })
  }
  return found
}

function isSource(path: string): boolean {
  return langOf(path) !== undefined && !isTestFile(path) && !STORY_FILE.test(path)
}

/**
 * A Markdown section for the review prompt describing who depends on the declarations a merge
 * request changes, computed from the checkout at `dir` without a model:
 *
 * - For every JavaScript/TypeScript source file in scope (test files and stories excluded), the
 *   top-level functions, classes, class methods, accessors and fields, exported consts,
 *   interfaces, types and enums whose range holds one of the file's `lines`. At most 25 are
 *   listed, members and functions with the most changed lines first.
 * - For each, the lines outside the declaration that use its name (identifier matches; imports,
 *   definitions, strings and comments excluded; members match property positions only), with
 *   test files listed apart and, for fields and accessors, writes apart from reads. Names under
 *   four characters or with more than 60 reference lines are reported as skipped.
 * - For every changed source file, the test files that import it or are named after it nearby.
 *
 * Matches are by name, so they can include unrelated symbols, and the intro says so. The result
 * is deterministic for the same checkout and scope, at most `maxChars` long (overflow ends with
 * `… N more symbols not shown`), and `''` when there is nothing to report. A file that cannot be
 * read or parsed is skipped; only an aborted `signal` makes it reject.
 */
export async function impactSection(options: ImpactOptions): Promise<string> {
  const { dir, signal } = options
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  signal?.throwIfAborted()
  const sources = options.files
    .filter((file) => file.lines.size > 0 && isSource(file.path))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (sources.length === 0) return ''
  const checkout = new Checkout(dir)
  await checkout.load(signal)

  const declarations: Declaration[] = []
  for (const file of sources) {
    signal?.throwIfAborted()
    const root = checkout.root(file.path)
    if (root) declarations.push(...changedDeclarations(file.path, root, file.lines))
  }
  const ranked = declarations.toSorted(
    (a, b) =>
      PRIORITY[a.kind] - PRIORITY[b.kind] ||
      b.changed.length - a.changed.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.start - b.start,
  )
  const symbols = ranked
    .slice(0, MAX_SYMBOLS)
    .map((declaration) => renderSymbol(declaration, findReferences(checkout, declaration, signal)))

  const testLines: string[] = []
  let anyTests = false
  for (const file of sources) {
    signal?.throwIfAborted()
    const tests = testsOf(checkout, file.path)
    anyTests ||= tests.length > 0
    testLines.push(
      tests.length === 0
        ? `- ${file.path}: none found`
        : `- ${file.path}: ${tests.map((test) => `${test.path} (${test.why})`).join(', ')}`,
    )
  }
  if (symbols.length === 0 && !anyTests) return ''

  const head = [
    '## Impact of the changed code (computed)',
    'Callers, readers/writers and tests of declarations this merge request changes, found by name in the checkout; name matches can include unrelated symbols.',
  ].join('\n\n')
  const tests = ['### Tests of the changed files', ...testLines].join('\n')
  const parts = [head]
  let length = head.length + 2 + tests.length
  let shown = 0
  for (const symbol of symbols) {
    // Leave room for the overflow note so the result never exceeds the cap.
    const reserve = shown + 1 < ranked.length ? 40 : 0
    if (length + symbol.length + 2 + reserve > maxChars) break
    parts.push(symbol)
    length += symbol.length + 2
    shown++
  }
  if (shown < ranked.length) parts.push(`… ${ranked.length - shown} more symbols not shown`)
  parts.push(tests)
  const result = parts.join('\n\n')
  return result.length <= maxChars ? result : `${result.slice(0, maxChars - 1)}…`
}
