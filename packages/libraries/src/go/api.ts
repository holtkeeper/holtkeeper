import type { ApiPackage, ApiSymbol, ApiSymbolKind } from '@holtkeeper/api-surface'

import type { ArchiveFiles } from '../types.ts'

export interface GoApiOptions {
  /** Module path (with its `/vN` suffix); read from `go.mod` when left out. */
  module?: string
  version?: string
  /** Symbols kept per package; the rest is counted in `truncated`. Default 2000. */
  maxSymbols?: number
}

const maxSignature = 4000
const maxValue = 80
const ident = /^[\p{L}_][\p{L}\p{N}_]*/u
const isExported = (name: string) => /^\p{Lu}/u.test(name)
const platformSuffix =
  /_(aix|android|darwin|dragonfly|freebsd|illumos|ios|js|linux|netbsd|openbsd|plan9|solaris|wasip1|windows|386|amd64|arm|arm64|loong64|mips\w*|ppc64\w*|riscv64|s390x|wasm)\.go$/

interface Masks {
  /** Strings, runes and comments blanked: for structure. */
  structure: string
  /** Only comments blanked: for signatures. */
  code: string
}

const blank = (target: string[], from: number, to: number) => {
  for (let k = from; k < to; k++) if (target[k] !== '\n') target[k] = ' '
}

function mask(source: string): Masks {
  const structure = source.split('')
  const code = source.split('')
  let i = 0
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    let end = i + 1
    if (char === '/' && next === '/') {
      end = source.indexOf('\n', i)
      if (end < 0) end = source.length
      blank(structure, i, end)
      blank(code, i, end)
    } else if (char === '/' && next === '*') {
      end = source.indexOf('*/', i + 2)
      end = end < 0 ? source.length : end + 2
      blank(structure, i, end)
      blank(code, i, end)
    } else if (char === '"' || char === "'") {
      end = i + 1
      while (end < source.length && source[end] !== char && source[end] !== '\n')
        end += source[end] === '\\' ? 2 : 1
      end = Math.min(end + 1, source.length)
      blank(structure, i + 1, end - 1)
    } else if (char === '`') {
      end = source.indexOf('`', i + 1)
      end = end < 0 ? source.length : end + 1
      blank(structure, i + 1, end - 1)
    }
    i = end
  }
  return { structure: structure.join(''), code: code.join('') }
}

const depthDelta = (line: string) => {
  let delta = 0
  for (const char of line) {
    if (char === '(' || char === '[' || char === '{') delta++
    else if (char === ')' || char === ']' || char === '}') delta--
  }
  return delta
}

const collapse = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/([([{])\s+/g, '$1')
    .replace(/,?\s+([)\]])/g, '$1')
    .trim()

const cap = (text: string) =>
  text.length > maxSignature ? `${text.slice(0, maxSignature)} …` : text

/** Doc comment text and its `Deprecated:` paragraph. */
export function parseGoDoc(lines: string[]): { doc?: string; deprecated?: string } {
  const doc = lines.join('\n').trim()
  if (!doc) return {}
  const paragraph = /(?:^|\n\s*\n)Deprecated:\s*([\s\S]*?)(?=\n\s*\n|$)/.exec(doc)?.[1]
  return {
    doc,
    ...(paragraph !== undefined ? { deprecated: paragraph.replace(/\s+/g, ' ').trim() } : {}),
  }
}

const typeSignature = (lines: string[]) => {
  if (lines.length === 1) return lines[0]?.trim() ?? ''
  const kept: string[] = [lines[0]?.trimEnd() ?? '']
  let dropped = false
  let keep = true
  let level = depthDelta(lines[0] ?? '')
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k] ?? ''
    const trimmed = line.trim()
    const atField = level === 1
    if (k === lines.length - 1 && /^[)}\]]/.test(trimmed)) {
      if (dropped) kept.push('\t// contains filtered or unexported fields')
      kept.push(line.trimEnd())
      break
    }
    if (atField && trimmed) {
      const first = ident.exec(trimmed.replace(/^\*/, ''))?.[0] ?? ''
      keep =
        trimmed.startsWith('~') ||
        isExported(first) ||
        /^\*?[\p{L}_][\p{L}\p{N}_]*\.\p{Lu}/u.test(trimmed)
      if (!keep) dropped = true
    }
    if (trimmed && keep) kept.push(line.trimEnd())
    level += depthDelta(lines[k] ?? '')
  }
  return kept.join('\n')
}

interface FileScan {
  packageName?: string
  packageDoc?: string
  ignored: boolean
  symbols: ApiSymbol[]
}

function scanFile(path: string, source: string): FileScan {
  const masks = mask(source)
  const original = source.split('\n')
  const structure = masks.structure.split('\n')
  const code = masks.code.split('\n')
  const depth: number[] = []
  let current = 0
  for (const line of structure) {
    depth.push(current)
    current += depthDelta(line)
  }
  depth.push(current)

  const docAbove = (index: number) => {
    const lines: string[] = []
    let k = index - 1
    const last = original[k]?.trim() ?? ''
    if (last.endsWith('*/') && !last.startsWith('//')) {
      const block: string[] = []
      while (k >= 0) {
        const text = original[k] ?? ''
        block.unshift(text)
        k--
        if (text.includes('/*')) break
      }
      return block
        .join('\n')
        .replace(/^\s*\/\*/, '')
        .replace(/\*\/\s*$/, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\* ?/, ''))
    }
    while (k >= 0) {
      const match = /^\s*\/\/(.*)$/.exec(original[k] ?? '')
      if (!match) break
      const text = match[1] ?? ''
      if (!/^[a-z]+:\S/.test(text)) lines.unshift(text.replace(/^ /, ''))
      k--
    }
    return lines
  }

  const scan: FileScan = { ignored: false, symbols: [] }
  const add = (
    name: string,
    kind: ApiSymbolKind,
    signature: string,
    line: number,
    docLines: string[],
  ) => {
    scan.symbols.push({
      name,
      kind,
      signature: cap(signature),
      ...parseGoDoc(docLines),
      file: path,
      line: line + 1,
    })
  }

  const spanEnd = (start: number) => {
    let end = start
    while (end < structure.length - 1 && (depth[end + 1] ?? 0) > (depth[start] ?? 0)) end++
    return end
  }

  const valueSpecs = (
    keyword: 'const' | 'var',
    specLines: string[],
    structureLines: string[],
    line: number,
    docLines: string[],
    previousType: { value?: string },
  ) => {
    const text = specLines.join('\n').trim()
    const shape = structureLines.join('\n').trim()
    const names = /^([\p{L}_][\p{L}\p{N}_]*(?:\s*,\s*[\p{L}_][\p{L}\p{N}_]*)*)/u.exec(shape)?.[1]
    if (!names) return
    const rest = text.slice(names.length)
    const restShape = shape.slice(names.length)
    const equals = restShape.search(/(?<![=!<>:])=(?!=)/)
    const type = (equals < 0 ? rest : rest.slice(0, equals)).trim()
    const value = equals < 0 ? '' : rest.slice(equals + 1).trim()
    if (type) previousType.value = type
    else if (equals >= 0) previousType.value = undefined
    const shownType = type || (equals < 0 && keyword === 'const' ? (previousType.value ?? '') : '')
    const shownValue =
      equals < 0 ? '' : !value.includes('\n') && value.length <= maxValue ? ` = ${value}` : ' = …'
    const list = names.split(',').map((name) => name.trim())
    const signature = `${keyword} ${list.join(', ')}${shownType ? ` ${collapse(shownType)}` : ''}${shownValue}`
    for (const name of list) if (isExported(name)) add(name, 'variable', signature, line, docLines)
  }

  const funcDecl = (start: number, end: number) => {
    const text = code.slice(start, end + 1).join('\n')
    const shape = structure.slice(start, end + 1).join('\n')
    let round = 0
    let curly = 0
    let stop = shape.length
    for (let k = 0; k < shape.length; k++) {
      const char = shape[k]
      if (char === '(' || char === '[') round++
      else if (char === ')' || char === ']') round--
      else if (char === '{') {
        if (round === 0 && curly === 0 && !/\b(struct|interface)\s*$/.test(shape.slice(0, k))) {
          stop = k
          break
        }
        curly++
      } else if (char === '}') curly--
      else if (char === '\n' && round === 0 && curly === 0) {
        stop = k
        break
      }
    }
    const signature = collapse(text.slice(0, stop))
    const header = /^func\s*(?:\(([^)]*)\))?\s*([\p{L}_][\p{L}\p{N}_]*)/u.exec(signature)
    if (!header) return
    const name = header[2] ?? ''
    if (!isExported(name)) return
    const docLines = docAbove(start)
    if (header[1] === undefined) {
      add(name, 'function', signature, start, docLines)
      return
    }
    const receiver = /\*?\s*([\p{L}_][\p{L}\p{N}_]*)\s*(?:\[[^\]]*\])?\s*$/u.exec(header[1])?.[1]
    if (receiver && isExported(receiver))
      add(`${receiver}.${name}`, 'function', signature, start, docLines)
  }

  const typeSpec = (specCode: string[], start: number, docLines: string[], prefix: string) => {
    const name = ident.exec(specCode[0]?.trim() ?? '')?.[0]
    if (!name || !isExported(name)) return
    const signature = typeSignature(
      specCode.map((line, k) => (k === 0 ? prefix + line.trim() : line)),
    )
    const after = (specCode[0] ?? '').trim().slice(name.length)
    const body = after.startsWith('[') ? after.slice(bracketEnd(after) + 1) : after
    const kind: ApiSymbolKind = /^\s*(=\s*)?interface\b/.test(body) ? 'interface' : 'type'
    add(name, kind, signature, start, docLines)
  }

  let index = 0
  while (index < structure.length) {
    const shape = structure[index]?.trim() ?? ''
    if ((depth[index] ?? 0) !== 0 || !shape) {
      index++
      continue
    }
    const end = spanEnd(index)
    const keyword = /^(package|func|type|const|var)\b/.exec(shape)?.[1]
    if (keyword === 'package') {
      const name = /^package\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(shape)?.[1]
      scan.packageName = name
      const header = original.slice(0, index).join('\n')
      if (
        /^\s*\/\/go:build\s+ignore\b/m.test(header) ||
        /^\s*\/\/\s*\+build\s+ignore\b/m.test(header)
      )
        scan.ignored = true
      const doc = parseGoDoc(docAbove(index)).doc
      if (doc) scan.packageDoc = doc
    } else if (keyword === 'func') {
      funcDecl(index, end)
    } else if (keyword === 'type' || keyword === 'const' || keyword === 'var') {
      const grouped = new RegExp(`^${keyword}\\s*\\($`).test(shape)
      const outerDoc = docAbove(index)
      if (!grouped) {
        const specCode = code.slice(index, end + 1)
        specCode[0] = (specCode[0] ?? '').replace(new RegExp(`^\\s*${keyword}\\s+`), '')
        const specShape = structure.slice(index, end + 1)
        specShape[0] = (specShape[0] ?? '').replace(new RegExp(`^\\s*${keyword}\\s+`), '')
        if (keyword === 'type') typeSpec(specCode, index, outerDoc, 'type ')
        else valueSpecs(keyword, specCode, specShape, index, outerDoc, {})
      } else {
        const previousType: { value?: string } = {}
        let k = index + 1
        const close = end
        while (k < close) {
          if (!structure[k]?.trim()) {
            k++
            continue
          }
          const specEnd = Math.min(spanEnd(k), close - 1)
          const inner = docAbove(k)
          const docLines = inner.length ? inner : outerDoc
          const specCode = code.slice(k, specEnd + 1)
          if (keyword === 'type') typeSpec(specCode, k, docLines, 'type ')
          else
            valueSpecs(
              keyword,
              specCode,
              structure.slice(k, specEnd + 1),
              k,
              docLines,
              previousType,
            )
          k = specEnd + 1
        }
      }
    }
    index = end + 1
  }
  return scan
}

function bracketEnd(text: string) {
  let level = 0
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '[') level++
    else if (text[k] === ']' && --level === 0) return k
  }
  return text.length
}

const firstSentence = (doc: string) => {
  const paragraph =
    doc
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? ''
  const sentence = /^(.*?[.!?])(\s|$)/.exec(paragraph)?.[1] ?? paragraph
  return sentence.length > 300 ? `${sentence.slice(0, 300)}…` : sentence
}

const skippedDir = (dir: string) =>
  dir
    .split('/')
    .some(
      (segment) =>
        segment === 'internal' ||
        segment === 'vendor' ||
        segment === 'testdata' ||
        segment.startsWith('_') ||
        segment.startsWith('.'),
    )

/**
 * Go API of one module version from the files of its module zip: one `ApiPackage` per importable
 * package directory (named by its import path, `dir` relative to the module root), each with a
 * single entry `.` listing exported functions, methods (`Type.Method`), types (`interface` or
 * `type`), constants and variables (`variable`, the signature starts with `const` or `var`).
 * Doc comments are kept, `Deprecated:` paragraphs become `deprecated`, and package docs become
 * `description`. Skips `internal/`, `vendor/`, `testdata/`, `_test.go` files, `package main` and
 * files with `//go:build ignore`.
 *
 * This is a line and bracket scan of gofmt-formatted source, not a Go parser: it does not apply
 * build constraints other than `ignore` (a symbol declared per platform appears once), and
 * unformatted code (several declarations on one line) may be read incompletely.
 */
export function goApi(files: ArchiveFiles, options: GoApiOptions = {}): ApiPackage[] {
  const decoder = new TextDecoder()
  const goMod = files.get('go.mod')
  const module =
    options.module ??
    (goMod ? /^\s*module\s+"?([^\s"]+)"?/m.exec(decoder.decode(goMod))?.[1] : undefined) ??
    ''
  const maxSymbols = options.maxSymbols ?? 2000

  const byDir = new Map<string, string[]>()
  for (const path of files.keys()) {
    if (!path.endsWith('.go') || path.endsWith('_test.go')) continue
    const slash = path.lastIndexOf('/')
    const dir = slash < 0 ? '' : path.slice(0, slash)
    if (skippedDir(dir)) continue
    byDir.set(dir, [...(byDir.get(dir) ?? []), path])
  }

  const packages: ApiPackage[] = []
  for (const dir of [...byDir.keys()].toSorted()) {
    const paths = (byDir.get(dir) ?? []).toSorted(
      (a, b) =>
        Number(platformSuffix.test(a)) - Number(platformSuffix.test(b)) || a.localeCompare(b),
    )
    const symbols = new Map<string, ApiSymbol>()
    const problems: string[] = []
    let packageDoc: string | undefined
    let library = false
    for (const path of paths) {
      const bytes = files.get(path)
      if (!bytes) continue
      let scan: FileScan
      try {
        scan = scanFile(path, decoder.decode(bytes))
      } catch (error) {
        problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (scan.ignored || !scan.packageName || scan.packageName === 'main') continue
      if (scan.packageName.endsWith('_test')) continue
      library = true
      if (scan.packageDoc && (!packageDoc || path.endsWith('/doc.go') || path === 'doc.go'))
        packageDoc = scan.packageDoc
      for (const symbol of scan.symbols) {
        const existing = symbols.get(symbol.name)
        if (!existing || (!existing.doc && symbol.doc)) symbols.set(symbol.name, symbol)
      }
    }
    if (!library) continue
    const all = [...symbols.values()]
    const kept = all.slice(0, maxSymbols)
    packages.push({
      name: dir ? `${module}/${dir}` : module,
      ...(options.version ? { version: options.version } : {}),
      ...(packageDoc ? { description: firstSentence(packageDoc) } : {}),
      private: false,
      dir: dir || '.',
      entries: [
        {
          subpath: '.',
          symbols: kept,
          ...(all.length > kept.length ? { truncated: all.length - kept.length } : {}),
        },
      ],
      ...(problems.length ? { problems } : {}),
    })
  }
  return packages
}
