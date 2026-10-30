import { Lang, parse, type SgNode } from '@ast-grep/napi'

import type { DynamicUsage, KeyUsage } from './types.ts'

/** Translation calls recognized by default. */
export const DEFAULT_FUNCTIONS: readonly string[] = [
  't',
  'i18n.t',
  '$t',
  'this.$t',
  'useTranslation().t',
  '<Trans i18nKey>',
  '<FormattedMessage id>',
  'formatMessage({ id })',
  'intl.formatMessage',
]

/** A translation call shape, parsed from a `functions` option entry. */
export type UsagePattern =
  | { kind: 'call'; callee: string }
  | { kind: 'jsx'; element: string; attribute: string }

/**
 * `t`, `i18n.t`, `useTranslation().t` (calls of `t`), `formatMessage({ id })` (key from the `id`
 * property), `<Trans i18nKey>` (key from a JSX attribute).
 */
export function parsePattern(text: string): UsagePattern | undefined {
  const spec = text.trim()
  const jsx = /^<\s*([\w.]+)\s+([\w-]+)\s*\/?>$/.exec(spec)
  if (jsx?.[1] && jsx[2]) return { kind: 'jsx', element: jsx[1], attribute: jsx[2] }
  const call = /^([\w$.]+?)(?:\(\s*(?:\{[^}]*\})?\s*\))?$/.exec(spec)
  if (call?.[1]) return { kind: 'call', callee: call[1] }
  const hook = /^[\w$.]+\([^)]*\)\.([\w$]+)$/.exec(spec)
  if (hook?.[1]) return { kind: 'call', callee: hook[1] }
  return undefined
}

export interface FileUsages {
  keys: KeyUsage[]
  dynamic: DynamicUsage[]
}

const AST_LANGUAGES: Record<string, Lang> = {
  js: Lang.JavaScript,
  jsx: Lang.JavaScript,
  mjs: Lang.JavaScript,
  cjs: Lang.JavaScript,
  ts: Lang.TypeScript,
  mts: Lang.TypeScript,
  cts: Lang.TypeScript,
  tsx: Lang.Tsx,
}
const TEXT_LANGUAGES = new Set(['vue', 'svelte', 'astro', 'html'])

/** Whether `file` is source code the usage scan reads. */
export function isSourceFile(file: string): boolean {
  if (/\.d\.[cm]?ts$/.test(file) || /\.(test|spec)\.[^/]+$/.test(file)) return false
  if (/(^|\/)(__tests__|__mocks__)\//.test(file) || file.endsWith('.min.js')) return false
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  return ext in AST_LANGUAGES || TEXT_LANGUAGES.has(ext)
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
}

function decodeEscape(text: string): string {
  const body = text.slice(1)
  if (/^u\{[0-9a-fA-F]+\}$/.test(body))
    return String.fromCodePoint(Number.parseInt(body.slice(2, -1), 16))
  if (/^[ux][0-9a-fA-F]+$/.test(body))
    return String.fromCharCode(Number.parseInt(body.slice(1), 16))
  if (body.startsWith('\n') || body.startsWith('\r')) return ''
  return ESCAPES[body] ?? body
}

/** Static text of a string or substitution-free template node. */
function staticText(node: SgNode): string | undefined {
  const kind = String(node.kind())
  if (kind !== 'string' && kind !== 'template_string') return undefined
  let text = ''
  for (const child of node.children()) {
    const part = String(child.kind())
    if (part === 'string_fragment') text += child.text()
    else if (part === 'escape_sequence') text += decodeEscape(child.text())
    else if (part === 'template_substitution') return undefined
  }
  return text
}

/** The static start of a computed key: a template's leading text or a concatenation's. */
function staticPrefix(node: SgNode): string | undefined {
  const kind = String(node.kind())
  if (kind === 'template_string') {
    const first = node.children()[1]
    return first && String(first.kind()) === 'string_fragment' ? first.text() : undefined
  }
  if (kind === 'binary_expression') {
    const left = node.field('left')
    if (!left) return undefined
    return staticText(left) ?? staticPrefix(left)
  }
  if (kind === 'parenthesized_expression') {
    const inner = node.children()[1]
    return inner ? staticPrefix(inner) : undefined
  }
  return undefined
}

const at = (file: string, node: SgNode) => {
  const { line, column } = node.range().start
  return { file, line: line + 1, column: column + 1 }
}

function objectProperty(node: SgNode, name: string): SgNode | undefined {
  if (String(node.kind()) !== 'object') return undefined
  for (const pair of node.children()) {
    if (String(pair.kind()) !== 'pair') continue
    const key = pair.field('key')
    const keyText = key ? (staticText(key) ?? key.text()) : undefined
    if (keyText === name) return pair.field('value') ?? undefined
  }
  return undefined
}

function addKey(out: FileUsages, file: string, node: SgNode, namespace: string | undefined): void {
  const kind = String(node.kind())
  if (kind === 'array') {
    for (const item of node.children()) {
      if (String(item.kind()) === 'string' || String(item.kind()) === 'template_string')
        addKey(out, file, item, namespace)
    }
    return
  }
  const key = staticText(node)
  if (key !== undefined) {
    out.keys.push({ key, ...(namespace ? { namespace } : {}), ...at(file, node) })
    return
  }
  const prefix = staticPrefix(node)
  out.dynamic.push({ text: node.text(), ...(prefix ? { prefix } : {}), ...at(file, node) })
}

const normalize = (text: string) => text.replace(/\s+/g, '')

function scanAst(file: string, code: string, lang: Lang, patterns: readonly UsagePattern[]) {
  const out: FileUsages = { keys: [], dynamic: [] }
  const calls = new Set(patterns.flatMap((p) => (p.kind === 'call' ? [p.callee] : [])))
  const jsx = patterns.filter((p) => p.kind === 'jsx')
  const root = parse(lang, code).root()

  if (calls.size) {
    for (const call of root.findAll({ rule: { kind: 'call_expression' } })) {
      const callee = call.field('function')
      if (!callee || !calls.has(normalize(callee.text()))) continue
      const args = (call.field('arguments')?.children() ?? []).filter(
        (child) =>
          !['(', ')', ','].includes(String(child.kind())) && String(child.kind()) !== 'comment',
      )
      const first = args[0]
      if (!first) continue
      const options = args[1]
      const nsNode = options ? objectProperty(options, 'ns') : undefined
      const namespace = nsNode ? staticText(nsNode) : undefined
      const id = objectProperty(first, 'id')
      if (String(first.kind()) === 'object' && !id) continue
      addKey(out, file, id ?? first, namespace)
    }
  }

  if (jsx.length) {
    const elements = root.findAll({
      rule: { any: [{ kind: 'jsx_opening_element' }, { kind: 'jsx_self_closing_element' }] },
    })
    for (const element of elements) {
      const name = element.field('name')?.text()
      const wanted = jsx.filter((p) => p.element === name)
      if (wanted.length === 0) continue
      const attributes = element.children().filter((c) => String(c.kind()) === 'jsx_attribute')
      const attr = (attrName: string) =>
        attributes
          .find((a) => a.children()[0]?.text() === attrName)
          ?.children()
          .at(-1)
      const nsValue = attr('ns')
      const namespace = nsValue ? staticText(nsValue) : undefined
      for (const pattern of wanted) {
        const value = attr(pattern.attribute)
        if (!value || value.text() === pattern.attribute) continue
        const inner =
          String(value.kind()) === 'jsx_expression'
            ? value.children().find((c) => !['{', '}'].includes(String(c.kind())))
            : value
        if (inner) addKey(out, file, inner, namespace)
      }
    }
  }
  return out
}

function scanText(file: string, code: string, patterns: readonly UsagePattern[]): FileUsages {
  const out: FileUsages = { keys: [], dynamic: [] }
  const lineStarts = [0]
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) lineStarts.push(i + 1)
  const position = (offset: number) => {
    let line = 0
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++
    return { file, line: line + 1, column: offset - lineStarts[line]! + 1 }
  }
  for (const pattern of patterns) {
    if (pattern.kind !== 'call') continue
    const callee = pattern.callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const call = new RegExp(
      `(?<![\\w$.])${callee}\\(\\s*(?:(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1)?`,
      'g',
    )
    for (const match of code.matchAll(call)) {
      const [whole, quote, body = ''] = match
      const where = position(match.index)
      if (quote && !body.includes('${')) {
        out.keys.push({ key: body, ...where })
        continue
      }
      const after = code.slice(match.index + whole.length).split(/[,)\n]/)[0] ?? ''
      const text = quote ? `${quote}${body}${quote}` : after.trim().slice(0, 80)
      if (!text) continue
      const prefix = quote ? body.split('${')[0] : undefined
      out.dynamic.push({ text, ...(prefix ? { prefix } : {}), ...where })
    }
  }
  return out
}

/** Static keys and dynamic calls in one source file. */
export function scanSource(
  file: string,
  code: string,
  patterns: readonly UsagePattern[],
): FileUsages {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  const lang = AST_LANGUAGES[ext]
  if (lang !== undefined) return scanAst(file, code, lang, patterns)
  return scanText(file, code, patterns)
}
