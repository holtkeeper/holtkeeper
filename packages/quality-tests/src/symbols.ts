import type { TestLanguage } from './types.ts'

/** A function or method found in source, with its line span and decision points. */
export interface SourceFunction {
  /** `name`, or `Type.name` for methods. */
  name: string
  kind: 'function' | 'method'
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  /** Decision points in the body (`if`, loops, `case`, `&&`, `||`, ...). */
  branches: number
}

const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'void',
  'yield',
  'await',
  'delete',
  'instanceof',
  'new',
  'throw',
])

/**
 * Replaces comments and string contents with spaces, keeping newlines and quote characters, so
 * brace matching and keyword search on the result ignore text inside them. Approximate for JS
 * regular expression literals and JSX text.
 */
export function maskSource(text: string, language: TestLanguage): string {
  const out = text.split('')
  const n = text.length
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '
  }
  const js = language === 'js'
  const templates: number[] = []
  let braces = 0
  let last = ''
  let lastWordEnd = -1

  const scanTemplate = (start: number): number => {
    let j = start
    while (j < n) {
      const c = text[j]
      if (c === '\\') j += 2
      else if (c === '`') {
        blank(start, j)
        return j + 1
      } else if (c === '$' && text[j + 1] === '{') {
        blank(start, j)
        templates.push(braces)
        braces++
        return j + 2
      } else j++
    }
    blank(start, n)
    return n
  }

  const regexAllowed = (i: number): boolean => {
    if (last === '') return true
    if (/[\w$]/.test(last)) {
      let s = lastWordEnd
      while (s >= 0 && /[\w$]/.test(text[s] ?? '')) s--
      return REGEX_KEYWORDS.has(text.slice(s + 1, lastWordEnd + 1)) && i > lastWordEnd
    }
    return '(,=:[!&|?{};+-*%<>~^'.includes(last)
  }

  let i = 0
  while (i < n) {
    const c = text[i] ?? ''
    const next = text[i + 1]
    if (language === 'python' ? c === '#' : c === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      const j = end === -1 ? n : end
      blank(i, j)
      i = j
      continue
    }
    if (language !== 'python' && c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const j = end === -1 ? n : end + 2
      blank(i, j)
      i = j
      continue
    }
    if (
      language === 'python' &&
      (c === '"' || c === "'") &&
      text[i + 1] === c &&
      text[i + 2] === c
    ) {
      const end = text.indexOf(c.repeat(3), i + 3)
      const j = end === -1 ? n : end
      blank(i + 3, j)
      i = j + 3
      last = c
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = j + 1
      last = c
      continue
    }
    if (c === '`' && js) {
      i = scanTemplate(i + 1)
      last = '`'
      continue
    }
    if (c === '`' && language === 'go') {
      const end = text.indexOf('`', i + 1)
      const j = end === -1 ? n : end
      blank(i + 1, j)
      i = j + 1
      last = '`'
      continue
    }
    if (js && c === '/' && regexAllowed(i)) {
      let j = i + 1
      let inClass = false
      while (j < n && text[j] !== '\n') {
        const d = text[j]
        if (d === '\\') j++
        else if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        j++
      }
      if (text[j] === '/') {
        blank(i + 1, j)
        i = j + 1
        last = '/'
        continue
      }
    }
    if (c === '{') braces++
    if (c === '}') {
      braces--
      if (js && templates.length && templates.at(-1) === braces) {
        templates.pop()
        i = scanTemplate(i + 1)
        last = '`'
        continue
      }
    }
    if (!/\s/.test(c)) {
      last = c
      if (/[\w$]/.test(c)) lastWordEnd = i
    }
    i++
  }
  return out.join('')
}

/** Offsets where each line starts. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function matchBrace(masked: string, open: number): number {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++
    else if (masked[i] === '}' && --depth === 0) return i
  }
  return masked.length - 1
}

/**
 * Finds the end offset of a declaration starting at `from`: the brace that closes its body, or
 * the end of an arrow function's expression body. `undefined` when it has no body (overloads,
 * `declare`, abstract methods) or, with `requireArrow`, when it is not a function at all.
 */
function bodyEnd(masked: string, from: number, requireArrow: boolean): number | undefined {
  let parens = 0
  let arrow = !requireArrow
  for (let i = from; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(' || c === '[') parens++
    else if (c === ')' || c === ']') parens--
    else if (parens > 0) continue
    else if (c === '=' && masked[i + 1] === '>') {
      arrow = true
      let j = i + 2
      while (/\s/.test(masked[j] ?? '')) j++
      if (masked[j] === '{') return matchBrace(masked, j)
      return expressionEnd(masked, j)
    } else if (c === '{') {
      if (!arrow) return undefined
      return matchBrace(masked, i)
    } else if (c === ';') return undefined
    else if (c === '\n' && NEW_DECLARATION.test(masked.slice(i + 1, i + 200))) return undefined
  }
  return undefined
}

const NEW_DECLARATION =
  /^\s*(?:export\b|function\b|async\s+function\b|const\b|let\b|var\b|class\b|declare\b|import\b|@|(?:public|private|protected|static|abstract)\s)/

function expressionEnd(masked: string, from: number): number {
  let depth = 0
  for (let i = from; i < masked.length; i++) {
    const c = masked[i] ?? ''
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (depth === 0) return i - 1
      depth--
    } else if (depth === 0 && (c === ';' || c === ',')) return i
    else if (depth === 0 && c === '\n') {
      const rest = masked.slice(i + 1).match(/^\s*(\S)/)?.[1] ?? ''
      if (!'.?:+-*/&|=<>'.includes(rest) || rest === '') return i - 1
    }
  }
  return masked.length - 1
}

const JS_DECISIONS = /\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?|\?(?![.?:])/g
const GO_DECISIONS = /\b(?:if|for|case|select)\b|&&|\|\|/g
const PY_DECISIONS = /\b(?:if|elif|for|while|except|and|or|case)\b/g

function countDecisions(masked: string, language: TestLanguage): number {
  const pattern = language === 'js' ? JS_DECISIONS : language === 'go' ? GO_DECISIONS : PY_DECISIONS
  return masked.match(pattern)?.length ?? 0
}

function depthAtLineStarts(masked: string, starts: readonly number[]): number[] {
  const depths: number[] = []
  let depth = 0
  let line = 0
  for (let i = 0; i <= masked.length; i++) {
    while (line < starts.length && starts[line] === i) {
      depths.push(depth)
      line++
    }
    const c = masked[i]
    if (c === '{') depth++
    else if (c === '}') depth--
  }
  return depths
}

const JS_FUNCTION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/
const JS_ARROW =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(function\b|\(|<|[A-Za-z_$][\w$]*\s*=>)/
const JS_CLASS = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
const JS_METHOD =
  /^\s*(?:(?:public|private|protected|static|async|readonly|override|get|set|accessor)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/
const JS_PROPERTY_ARROW =
  /^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(|<|[A-Za-z_$][\w$]*\s*=>)/
const NOT_METHODS = new Set([
  'constructor',
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'super',
])

function jsFunctions(masked: string): SourceFunction[] {
  const starts = lineStarts(masked)
  const depths = depthAtLineStarts(masked, starts)
  const lines = masked.split('\n')
  const found: SourceFunction[] = []
  const classes: { name: string; start: number; end: number }[] = []

  const add = (
    name: string,
    kind: SourceFunction['kind'],
    lineIndex: number,
    end: number | undefined,
  ) => {
    if (end === undefined) return
    const offset = starts[lineIndex] ?? 0
    const endLine = lineAt(starts, end)
    found.push({
      name,
      kind,
      startLine: lineIndex + 1,
      endLine,
      branches: countDecisions(masked.slice(offset, end + 1), 'js'),
    })
  }

  for (const [index, line] of lines.entries()) {
    const depth = depths[index] ?? 0
    const offset = starts[index] ?? 0
    if (depth === 0) {
      const fn = JS_FUNCTION.exec(line)
      if (fn?.[1]) {
        add(fn[1], 'function', index, bodyEnd(masked, offset + fn[0].length - 1, false))
        continue
      }
      const arrow = JS_ARROW.exec(line)
      if (arrow?.[1]) {
        const eq = line.indexOf('=', line.indexOf(arrow[1]) + arrow[1].length)
        add(arrow[1], 'function', index, bodyEnd(masked, offset + eq + 1, arrow[2] !== 'function'))
        continue
      }
      const cls = JS_CLASS.exec(line)
      if (cls?.[1]) {
        const open = masked.indexOf('{', offset)
        if (open !== -1)
          classes.push({
            name: cls[1],
            start: index + 1,
            end: lineAt(starts, matchBrace(masked, open)),
          })
      }
      continue
    }
    const owner = classes.find((cls) => index + 1 > cls.start && index + 1 < cls.end)
    if (!owner || depth !== (depths[owner.start - 1] ?? 0) + 1) continue
    const method = JS_METHOD.exec(line)
    if (method?.[1] && !NOT_METHODS.has(method[1])) {
      add(
        `${owner.name}.${method[1]}`,
        'method',
        index,
        bodyEnd(masked, offset + method[0].length - 1, false),
      )
      continue
    }
    const property = JS_PROPERTY_ARROW.exec(line)
    if (property?.[1]) {
      const eq = line.indexOf('=', line.indexOf(property[1]) + property[1].length)
      add(`${owner.name}.${property[1]}`, 'method', index, bodyEnd(masked, offset + eq + 1, true))
    }
  }
  return found
}

const GO_FUNC = /^func\s+(?:\(\s*(?:\w+\s+)?\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*)?(\w+)\s*[[(]/

function goFunctions(masked: string): SourceFunction[] {
  const starts = lineStarts(masked)
  const found: SourceFunction[] = []
  for (const [index, line] of masked.split('\n').entries()) {
    const match = GO_FUNC.exec(line)
    if (!match?.[2]) continue
    const offset = starts[index] ?? 0
    const end = bodyEnd(masked, offset + match[0].length - 1, false)
    if (end === undefined) continue
    found.push({
      name: match[1] ? `${match[1]}.${match[2]}` : match[2],
      kind: match[1] ? 'method' : 'function',
      startLine: index + 1,
      endLine: lineAt(starts, end),
      branches: countDecisions(masked.slice(offset, end + 1), 'go'),
    })
  }
  return found
}

const PY_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/
const PY_CLASS = /^class\s+(\w+)/

const indent = (line: string) => line.length - line.trimStart().length

function pythonFunctions(masked: string): SourceFunction[] {
  const lines = masked.split('\n')
  const blockEnd = (index: number, base: number) => {
    let end = index
    for (let k = index + 1; k < lines.length; k++) {
      const line = lines[k] ?? ''
      if (!line.trim()) continue
      if (indent(line) <= base) break
      end = k
    }
    return end
  }

  const found: SourceFunction[] = []
  let owner: { name: string; end: number; bodyIndent?: number } | undefined
  for (const [index, line] of lines.entries()) {
    if (owner && index > owner.end) owner = undefined
    const cls = PY_CLASS.exec(line)
    if (cls?.[1]) {
      owner = { name: cls[1], end: blockEnd(index, 0) }
      continue
    }
    const def = PY_DEF.exec(line)
    if (!def?.[2]) continue
    const base = def[1]?.length ?? 0
    let name = def[2]
    let kind: SourceFunction['kind'] = 'function'
    if (base > 0) {
      if (!owner) continue
      owner.bodyIndent ??= base
      if (base !== owner.bodyIndent) continue
      name = `${owner.name}.${name}`
      kind = 'method'
    }
    const end = blockEnd(index, base)
    found.push({
      name,
      kind,
      startLine: index + 1,
      endLine: end + 1,
      branches: countDecisions(lines.slice(index, end + 1).join('\n'), 'python'),
    })
  }
  return found
}

/**
 * Top-level functions and class methods of a source file with their line spans. A lightweight
 * scanner, not a parser: unusual syntax may hide a function, but strings and comments never
 * produce false ones.
 */
export function findFunctions(text: string, language: TestLanguage): SourceFunction[] {
  const masked = maskSource(text, language)
  if (language === 'js') return jsFunctions(masked)
  if (language === 'go') return goFunctions(masked)
  return pythonFunctions(masked)
}

/** Lines that hold code (not blank, not only comments) within an inclusive range. */
export function codeLines(
  text: string,
  language: TestLanguage,
  startLine: number,
  endLine: number,
): number {
  return maskSource(text, language)
    .split('\n')
    .slice(startLine - 1, endLine)
    .filter((line) => line.trim() !== '').length
}

/** Whether a TypeScript file only declares types: no runtime statements at module level. */
export function isTypeOnlySource(text: string): boolean {
  const masked = maskSource(text, 'js')
  const depths = depthAtLineStarts(masked, lineStarts(masked))
  const topLevel = masked
    .split('\n')
    .filter((_, index) => depths[index] === 0)
    .map((line) => line.trim())
    .filter(Boolean)
  const runtime =
    /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|enum|abstract)\b|^export\s+(?:default|\{|\*\s+from)|^import\s+(?!type\b)|^[\w$.]+\s*\(/
  return (
    topLevel.some((line) => /^(?:export\s+)?(?:declare\s+)?(?:type|interface)\b/.test(line)) &&
    !topLevel.some(
      (line) =>
        runtime.test(line) &&
        !/^(?:export\s+)?declare\s+(?:const|let|var|function|class)\b/.test(line),
    )
  )
}
