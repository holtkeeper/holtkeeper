import { Lang, parse, type SgNode } from '@ast-grep/napi'

import { clip } from '../budget.ts'
import { extensionOf } from '../files.ts'

/** Languages the structural tools understand: the parsers built into `@ast-grep/napi`. */
export const LANGUAGES = ['typescript', 'tsx', 'javascript', 'css', 'html'] as const
export type LanguageName = (typeof LANGUAGES)[number]

const langs: Record<LanguageName, Lang> = {
  typescript: Lang.TypeScript,
  tsx: Lang.Tsx,
  javascript: Lang.JavaScript,
  css: Lang.Css,
  html: Lang.Html,
}

/** File extensions of each language. */
export const LANGUAGE_EXTENSIONS: Readonly<Record<LanguageName, readonly string[]>> = {
  typescript: ['.ts', '.mts', '.cts'],
  tsx: ['.tsx'],
  javascript: ['.js', '.mjs', '.cjs', '.jsx'],
  css: ['.css'],
  html: ['.html', '.htm'],
}

/** Extensions of the JavaScript family, which the outline and symbol tools cover. */
export const SCRIPT_EXTENSIONS: readonly string[] = [
  ...LANGUAGE_EXTENSIONS.typescript,
  ...LANGUAGE_EXTENSIONS.tsx,
  ...LANGUAGE_EXTENSIONS.javascript,
]

/** The language of a file by its extension, if it is one of `LANGUAGES`. */
export function languageOf(file: string): LanguageName | undefined {
  const extension = extensionOf(file)
  return LANGUAGES.find((name) => LANGUAGE_EXTENSIONS[name].includes(extension))
}

/** The syntax tree root of `source`. */
export function parseSource(language: LanguageName, source: string): SgNode {
  return parse(langs[language], source).root()
}

/** 1-based first and last line of a node. */
export function linesOf(node: SgNode): { start: number; end: number } {
  const { start, end } = node.range()
  return { start: start.line + 1, end: end.line + 1 }
}

const BODY_KINDS = new Set([
  'statement_block',
  'class_body',
  'interface_body',
  'object_type',
  'enum_body',
])

/** The declaration an `export` or `declare` wraps, or the node itself. */
function unwrap(node: SgNode): SgNode {
  let target = node
  if (target.kind() === 'export_statement') target = target.field('declaration') ?? target
  if (target.kind() === 'ambient_declaration')
    target =
      target.children().find((child) => DECLARATION_KINDS.has(String(child.kind()))) ?? target
  return target
}

function bodyOf(node: SgNode): SgNode | undefined {
  const target = unwrap(node)
  const body = target.field('body')
  if (body && BODY_KINDS.has(String(body.kind()))) return body
  return target.children().find((child) => BODY_KINDS.has(String(child.kind())))
}

/**
 * One line that stands for a declaration: its text up to the body (`function f(a): T`,
 * `export class A extends B`), whitespace collapsed; declarations without a body give their first
 * line, with ` …` when they continue.
 */
export function headOf(node: SgNode, maxLength: number): string {
  const text = node.text()
  const body = bodyOf(node)
  let head: string
  if (body) {
    const at = text.lastIndexOf(body.text())
    head = at > 0 ? text.slice(0, at) : (text.split('\n')[0] ?? '')
  } else {
    const [first = '', ...rest] = text.split('\n')
    head = rest.length > 0 ? `${first} …` : first
  }
  return clip(head.replaceAll(/\s+/g, ' ').trim(), maxLength)
}

const MEMBER_KINDS = new Set([
  'method_definition',
  'public_field_definition',
  'abstract_method_signature',
  'method_signature',
  'property_signature',
  'index_signature',
  'construct_signature',
  'call_signature',
])

const DECLARATION_KINDS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_declaration',
  'export_statement',
  'ambient_declaration',
  'module',
  'internal_module',
  'expression_statement',
])

/** One outline entry: a declaration with its line range and nesting depth. */
export interface OutlineEntry {
  start: number
  end: number
  depth: number
  head: string
}

function isModuleExpression(node: SgNode): boolean {
  const expression = node.child(0)
  return expression?.kind() === 'internal_module'
}

function membersOf(node: SgNode): SgNode[] {
  const body = bodyOf(node)
  if (!body) return []
  if (body.kind() === 'statement_block') return body.children()
  return body.children().filter((child) => MEMBER_KINDS.has(String(child.kind())))
}

/** Whether a declaration's body lists members worth showing (classes, interfaces, namespaces). */
function hasMembers(node: SgNode): boolean {
  return [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'module',
    'internal_module',
  ].includes(String(unwrap(node).kind()))
}

/**
 * Declarations of a JavaScript-family file in source order: top-level functions, classes,
 * interfaces, types, enums, variables and exports, with class and interface members and
 * namespace contents nested one level deeper. Imports collapse into one entry.
 */
export function outline(root: SgNode, maxLength: number): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  const imports = root.children().filter((child) => child.kind() === 'import_statement')
  const first = imports[0]
  const last = imports.at(-1)
  if (first && last) {
    const sources = imports
      .map((node) => node.field('source')?.text().slice(1, -1))
      .filter((source): source is string => Boolean(source))
    entries.push({
      start: linesOf(first).start,
      end: linesOf(last).end,
      depth: 0,
      head: clip(`imports (${imports.length}): ${[...new Set(sources)].join(', ')}`, maxLength),
    })
  }
  const visit = (nodes: SgNode[], depth: number) => {
    for (const node of nodes) {
      const kind = String(node.kind())
      const isMember = depth > 0 && MEMBER_KINDS.has(kind)
      if (!isMember && !DECLARATION_KINDS.has(kind)) continue
      if (kind === 'expression_statement' && !isModuleExpression(node)) continue
      const { start, end } = linesOf(node)
      entries.push({ start, end, depth, head: headOf(node, maxLength) })
      if (depth < 2 && hasMembers(node)) visit(membersOf(node), depth + 1)
    }
  }
  visit(root.children(), 0)
  return entries
}

/** `start-end head`, indented by depth. */
export function formatEntry(entry: OutlineEntry): string {
  const range = entry.start === entry.end ? `${entry.start}` : `${entry.start}-${entry.end}`
  return `${'  '.repeat(entry.depth)}${range} ${entry.head}`
}
