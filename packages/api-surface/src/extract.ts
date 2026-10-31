import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { parseSync } from 'oxc-parser'

import type { ApiEntry, ApiPackage, ApiSymbol, ApiSymbolKind } from './model.ts'
import { type PackageManifest, expandWildcard, findPackages, resolveEntry } from './packages.ts'

/** Caps that keep one analysis record small enough to store and send. */
export const extractLimits = { symbols: 1000, signature: 3000, doc: 1500, member: 200 }

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string' &&
  'start' in value &&
  typeof value.start === 'number'

const child = (node: Node, key: string): Node | undefined => {
  const value = node[key]
  return isNode(value) ? value : undefined
}

const children = (node: Node, key: string): Node[] => {
  const value = node[key]
  return Array.isArray(value) ? value.filter(isNode) : []
}

const nameOf = (node: Node | undefined): string | undefined => {
  if (!node) return undefined
  if (typeof node.name === 'string') return node.name
  if (typeof node.value === 'string') return node.value
  return undefined
}

interface Declaration {
  kind: Exclude<ApiSymbolKind, 'reexport'>
  signature: string
  doc?: string
  file: string
  line: number
}

type Export =
  | { type: 'declared'; exported: string; declarations: Declaration[] }
  | { type: 'local'; exported: string; local: string }
  | { type: 'from'; exported: string; imported: string; source: string; at: number }
  | { type: 'namespace'; exported: string; source: string; at: number }
  | { type: 'star'; source: string; at: number }

interface Module {
  file: string
  locals: Map<string, Declaration[]>
  imports: Map<string, { source: string; imported: string }>
  exports: Export[]
  line(offset: number): number
  problem?: string
}

const cap = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit).trimEnd()}\n…` : text

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Doc comment text without `/**`, `*` prefixes and `*\/`. */
function cleanDoc(value: string): string {
  return value
    .replace(/^\*/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
    .trim()
}

/** `@deprecated` text of a doc comment, `''` for a bare tag, `undefined` without one. */
export function deprecationOf(doc: string | undefined): string | undefined {
  if (!doc) return undefined
  const match = /@deprecated\b([^@]*)/.exec(doc)
  return match ? oneLine(match[1] ?? '') : undefined
}

const stripDeclare = (text: string) =>
  text
    .replace(/^declare\s+/, '')
    .replace(/;\s*$/, '')
    .replace(/^[ \t]*\/\/\s*(?:oxlint|eslint|biome|prettier|@ts-)[^\n]*\n/gm, '')

function lineIndex(text: string) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

/** Doc comments by the offset of the first code after them. */
function docIndex(text: string, comments: readonly Node[]) {
  const docs = new Map<number, string>()
  for (const comment of comments) {
    const value = typeof comment.value === 'string' ? comment.value : ''
    if (comment.type !== 'Block' || !value.startsWith('*')) continue
    const rest = /^(?:\s|\/\/[^\n]*)*/.exec(text.slice(comment.end, comment.end + 400))
    docs.set(comment.end + (rest?.[0].length ?? 0), cleanDoc(value))
  }
  return docs
}

function classSignature(text: string, node: Node, docs: Map<number, string>): string {
  const body = child(node, 'body')
  if (!body) return stripDeclare(text.slice(node.start, node.end))
  const header = stripDeclare(text.slice(node.start, body.start).trim())
  const members: string[] = []
  for (const member of children(body, 'body')) {
    const key = child(member, 'key')
    if (member.accessibility === 'private' || key?.type === 'PrivateIdentifier') continue
    if (member.type === 'StaticBlock') continue
    const value = child(member, 'value')
    let signature: string
    if (member.type.includes('Method')) {
      const fnBody = value ? child(value, 'body') : undefined
      signature = text.slice(member.start, fnBody ? fnBody.start : member.end)
    } else if (member.type.includes('Property') && value) {
      signature = text.slice(member.start, value.start).replace(/=\s*$/, '')
    } else signature = text.slice(member.start, member.end)
    const doc = docs.get(member.start)
    const comment = doc
      ? `/** ${cap(oneLine(doc), extractLimits.member).replace(/\n…$/, '…')} */\n  `
      : ''
    members.push(`${comment}${oneLine(signature).replace(/;$/, '')}`)
  }
  return members.length ? `${header} {\n  ${members.join('\n  ')}\n}` : `${header} {}`
}

function variableSignature(text: string, keyword: string, declarator: Node): string {
  const id = child(declarator, 'id')
  const init = child(declarator, 'init')
  const name = id ? text.slice(id.start, id.end) : '?'
  if (!init || (id && child(id, 'typeAnnotation'))) return `${keyword} ${name}`
  if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
    const fnBody = child(init, 'body')
    const head = oneLine(text.slice(init.start, fnBody ? fnBody.start : init.end))
    return `${keyword} ${name} = ${head}${init.type === 'ArrowFunctionExpression' ? ' …' : ' { … }'}`
  }
  const value = oneLine(text.slice(init.start, init.end))
  if (value.length <= 100) return `${keyword} ${name} = ${value}`
  const callee = init.type === 'CallExpression' ? child(init, 'callee') : undefined
  if (callee) return `${keyword} ${name} = ${oneLine(text.slice(callee.start, callee.end))}(…)`
  return `${keyword} ${name} = ${value.slice(0, 100)}…`
}

const declarationKinds: Record<string, Declaration['kind']> = {
  FunctionDeclaration: 'function',
  TSDeclareFunction: 'function',
  ClassDeclaration: 'class',
  TSInterfaceDeclaration: 'interface',
  TSTypeAliasDeclaration: 'type',
  TSEnumDeclaration: 'enum',
  TSModuleDeclaration: 'namespace',
}

/** Declarations a statement introduces, by name; `docAt` is where its doc comment ends. */
function declarationsOf(
  text: string,
  node: Node,
  docAt: number,
  context: { file: string; docs: Map<number, string>; line: (offset: number) => number },
): [string, Declaration][] {
  const doc = context.docs.get(docAt) ?? context.docs.get(node.start)
  const base = (offset: number) => ({
    file: context.file,
    line: context.line(offset),
    ...(doc ? { doc: cap(doc, extractLimits.doc) } : {}),
  })
  if (node.type === 'VariableDeclaration') {
    const keyword = typeof node.kind === 'string' ? node.kind : 'const'
    return children(node, 'declarations').flatMap((declarator): [string, Declaration][] => {
      const name = nameOf(child(declarator, 'id'))
      if (!name) return []
      const signature = variableSignature(text, keyword, declarator)
      return [[name, { kind: 'variable', signature, ...base(declarator.start) }]]
    })
  }
  const kind = declarationKinds[node.type]
  const name = nameOf(child(node, 'id'))
  if (!kind || !name) return []
  let signature: string
  if (kind === 'function') {
    const fnBody = child(node, 'body')
    signature = stripDeclare(text.slice(node.start, fnBody ? fnBody.start : node.end).trim())
  } else if (kind === 'class') signature = classSignature(text, node, context.docs)
  else signature = stripDeclare(text.slice(node.start, node.end).trim())
  return [[name, { kind, signature: cap(signature, extractLimits.signature), ...base(node.start) }]]
}

function parseModule(file: string, root: string, text: string): Module {
  const relativeFile = relative(root, file).split('\\').join('/')
  const result = parseSync(file, text, { sourceType: 'module' })
  const program: unknown = result.program
  const line = lineIndex(text)
  const docs = docIndex(
    text,
    result.comments.flatMap((comment) => (isNode(comment) ? [comment] : [])),
  )
  const context = { file: relativeFile, docs, line }
  const locals = new Map<string, Declaration[]>()
  const imports = new Map<string, { source: string; imported: string }>()
  const exports: Export[] = []
  const addLocal = (name: string, declaration: Declaration) =>
    locals.set(name, [...(locals.get(name) ?? []), declaration])

  const statements = isNode(program) ? children(program, 'body') : []
  for (const statement of statements) {
    const source = nameOf(child(statement, 'source'))
    switch (statement.type) {
      case 'ImportDeclaration': {
        if (!source) break
        for (const specifier of children(statement, 'specifiers')) {
          const local = nameOf(child(specifier, 'local'))
          if (!local) continue
          const imported =
            specifier.type === 'ImportDefaultSpecifier'
              ? 'default'
              : specifier.type === 'ImportNamespaceSpecifier'
                ? '*'
                : (nameOf(child(specifier, 'imported')) ?? local)
          imports.set(local, { source, imported })
        }
        break
      }
      case 'ExportAllDeclaration': {
        if (!source) break
        const exported = nameOf(child(statement, 'exported'))
        exports.push(
          exported
            ? { type: 'namespace', exported, source, at: statement.start }
            : { type: 'star', source, at: statement.start },
        )
        break
      }
      case 'ExportNamedDeclaration': {
        const declaration = child(statement, 'declaration')
        if (declaration) {
          for (const [name, found] of declarationsOf(text, declaration, statement.start, context)) {
            addLocal(name, found)
            exports.push({ type: 'local', exported: name, local: name })
          }
          break
        }
        for (const specifier of children(statement, 'specifiers')) {
          const local = nameOf(child(specifier, 'local'))
          const exported = nameOf(child(specifier, 'exported')) ?? local
          if (!local || !exported) continue
          exports.push(
            source
              ? { type: 'from', exported, imported: local, source, at: statement.start }
              : { type: 'local', exported, local },
          )
        }
        break
      }
      case 'ExportDefaultDeclaration':
      case 'TSExportAssignment': {
        const declaration = child(statement, 'declaration') ?? child(statement, 'expression')
        if (!declaration) break
        const named = declarationsOf(text, declaration, statement.start, context)
        if (named.length) {
          for (const [name, found] of named) addLocal(name, found)
          exports.push({ type: 'local', exported: 'default', local: named[0]?.[0] ?? '' })
          break
        }
        const local = declaration.type === 'Identifier' ? nameOf(declaration) : undefined
        if (local) {
          exports.push({ type: 'local', exported: 'default', local })
          break
        }
        const doc = docs.get(statement.start)
        const fnBody =
          declaration.type.includes('Function') || declaration.type === 'ClassDeclaration'
            ? child(declaration, 'body')
            : undefined
        const value = oneLine(text.slice(declaration.start, fnBody?.start ?? declaration.end))
        exports.push({
          type: 'declared',
          exported: 'default',
          declarations: [
            {
              kind: declaration.type.includes('Class')
                ? 'class'
                : declaration.type.includes('Function')
                  ? 'function'
                  : 'variable',
              signature: `export default ${value.length > 200 ? `${value.slice(0, 200)}…` : value}`,
              file: relativeFile,
              line: line(statement.start),
              ...(doc ? { doc: cap(doc, extractLimits.doc) } : {}),
            },
          ],
        })
        break
      }
      default:
        for (const [name, found] of declarationsOf(text, statement, statement.start, context))
          addLocal(name, found)
    }
  }
  const problem = statements.length ? undefined : result.errors[0]?.message
  return { file, locals, imports, exports, line, ...(problem ? { problem } : {}) }
}

const relativeSpecifier = (specifier: string) =>
  specifier === '.' || specifier.startsWith('./') || specifier.startsWith('../')

const moduleExtensions = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.mjs', '.jsx', '.cjs']

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The file a relative import specifier points at, TypeScript sources preferred. */
export function resolveImport(from: string, specifier: string): string | undefined {
  if (!relativeSpecifier(specifier)) return undefined
  const base = join(dirname(from), specifier)
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '')
  const candidates = [
    ...(stem === base ? [base] : []),
    ...moduleExtensions.map((extension) => `${stem}${extension}`),
    ...(stem === base ? [] : [base]),
    ...moduleExtensions.map((extension) => join(base, `index${extension}`)),
  ]
  return candidates.find(isFile)
}

const symbolOf = (name: string, declarations: Declaration[]): ApiSymbol => {
  const [first] = declarations
  const doc = declarations.find((declaration) => declaration.doc)?.doc
  const deprecated = deprecationOf(doc)
  return {
    name,
    kind: first?.kind ?? 'variable',
    signature: cap(
      declarations.map((declaration) => declaration.signature).join('\n'),
      extractLimits.signature,
    ),
    ...(doc ? { doc } : {}),
    ...(deprecated !== undefined ? { deprecated } : {}),
    file: first?.file ?? '',
    line: first?.line ?? 0,
  }
}
/** Reads and walks modules once per extraction, following re-exports between files. */
function createWalker(root: string, problems: Set<string>) {
  const modules = new Map<string, Promise<Module | undefined>>()
  const exportsCache = new Map<string, Promise<Map<string, ApiSymbol>>>()

  const load = (file: string) => {
    let pending = modules.get(file)
    if (!pending) {
      pending = readFile(file, 'utf8')
        .then((text) => parseModule(file, root, text))
        .then((parsed) => {
          if (parsed.problem) problems.add(`${relative(root, file)}: ${parsed.problem}`)
          return parsed
        })
        .catch((error: unknown) => {
          problems.add(
            `${relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`,
          )
          return undefined
        })
      modules.set(file, pending)
    }
    return pending
  }

  const external = (module: Module, name: string, signature: string, at: number): ApiSymbol => ({
    name,
    kind: 'reexport',
    signature,
    file: relative(root, module.file).split('\\').join('/'),
    line: module.line(at),
  })

  const resolveName = async (
    module: Module,
    name: string,
    exported: string,
    stack: Set<string>,
  ): Promise<ApiSymbol | undefined> => {
    const declarations = module.locals.get(name)
    if (declarations?.length) return symbolOf(exported, declarations)
    const imported = module.imports.get(name)
    if (!imported) return undefined
    return resolveFrom(module, imported.source, imported.imported, exported, 0, stack)
  }

  const resolveFrom = async (
    module: Module,
    source: string,
    imported: string,
    exported: string,
    at: number,
    stack: Set<string>,
  ): Promise<ApiSymbol | undefined> => {
    const target = resolveImport(module.file, source)
    if (!target) {
      const what =
        imported === '*'
          ? `* as ${exported}`
          : imported === exported
            ? imported
            : `${imported} as ${exported}`
      return external(module, exported, `export { ${what} } from '${source}'`, at)
    }
    const found = await exportsOf(target, stack)
    if (imported === '*') {
      const names = [...found.keys()].filter((key) => !key.startsWith('*:'))
      const preview = names.slice(0, 40).join(', ')
      return {
        name: exported,
        kind: 'namespace',
        signature: `namespace ${exported} { ${preview}${names.length > 40 ? ', …' : ''} }`,
        file: relative(root, target).split('\\').join('/'),
        line: 1,
      }
    }
    const symbol = found.get(imported)
    return symbol ? { ...symbol, name: exported } : undefined
  }

  const exportsOf = (file: string, stack = new Set<string>()): Promise<Map<string, ApiSymbol>> => {
    if (stack.has(file)) return Promise.resolve(new Map())
    const cached = exportsCache.get(file)
    if (cached) return cached
    const next = new Set(stack).add(file)
    const pending = (async () => {
      const result = new Map<string, ApiSymbol>()
      const module = await load(file)
      if (!module) return result
      const stars: Map<string, ApiSymbol>[] = []
      for (const item of module.exports) {
        // oxlint-disable-next-line no-await-in-loop -- exports resolve in source order; later ones win
        const symbol = await resolveExport(module, item, next, stars)
        if (symbol) result.set(symbol.key, symbol.symbol)
      }
      for (const star of stars)
        for (const [name, symbol] of star)
          if (name !== 'default' && !result.has(name)) result.set(name, symbol)
      return result
    })()
    exportsCache.set(file, pending)
    return pending
  }

  const resolveExport = async (
    module: Module,
    item: Export,
    stack: Set<string>,
    stars: Map<string, ApiSymbol>[],
  ): Promise<{ key: string; symbol: ApiSymbol } | undefined> => {
    switch (item.type) {
      case 'declared':
        return { key: item.exported, symbol: symbolOf(item.exported, item.declarations) }
      case 'local': {
        const symbol = await resolveName(module, item.local, item.exported, stack)
        return symbol ? { key: item.exported, symbol } : undefined
      }
      case 'from': {
        const symbol = await resolveFrom(
          module,
          item.source,
          item.imported,
          item.exported,
          item.at,
          stack,
        )
        return symbol ? { key: item.exported, symbol } : undefined
      }
      case 'namespace': {
        const symbol = await resolveFrom(module, item.source, '*', item.exported, item.at, stack)
        return symbol ? { key: item.exported, symbol } : undefined
      }
    }
    const target = resolveImport(module.file, item.source)
    if (!target)
      return {
        key: `*:${item.source}`,
        symbol: external(module, '*', `export * from '${item.source}'`, item.at),
      }
    stars.push(await exportsOf(target, stack))
    return undefined
  }

  return { exportsOf }
}

const bySymbol = (a: ApiSymbol, b: ApiSymbol) =>
  Number(a.name !== 'default') - Number(b.name !== 'default') || a.name.localeCompare(b.name)

/** Options of `extractApi`. */
export interface ExtractApiOptions {
  /** Checkout root. */
  dir: string
  /** Include packages marked `"private": true`. Default `true`. */
  includePrivate?: boolean
  /** Glob patterns of package names to keep, e.g. `@acme/*`; all when empty. */
  packages?: readonly string[]
  /** Glob patterns of package folders to leave out, e.g. `examples/*`. */
  exclude?: readonly string[]
}

/**
 * The public API of every package in a checkout: for each `exports` subpath (or the `types`,
 * `module`, `main` fallbacks) the names it exports with their declarations and doc comments,
 * following re-exports between files. Purely syntactic, nothing is built or type-checked, so it
 * works on TypeScript sources and on declaration files alike. A package none of whose entry
 * points resolves to a file falls back to its wildcard subpaths (`./*`), expanded into the modules
 * they cover; packages left with nothing are left out.
 */
export async function extractApi(options: ExtractApiOptions): Promise<ApiPackage[]> {
  const names = (options.packages ?? []).map((pattern) => new Bun.Glob(pattern))
  const excluded = (options.exclude ?? []).map((pattern) => new Bun.Glob(pattern))
  const manifests = (await findPackages(options.dir)).filter(
    (manifest) =>
      ((options.includePrivate ?? true) ? true : !manifest.private) &&
      (!names.length || names.some((glob) => glob.match(manifest.name))) &&
      !excluded.some((glob) => glob.match(manifest.dir)),
  )
  const problems = new Set<string>()
  const walker = createWalker(options.dir, problems)
  const packages: ApiPackage[] = []
  for (const manifest of manifests) {
    // oxlint-disable-next-line no-await-in-loop -- packages share the module cache, one at a time
    const pkg = await extractPackage(options.dir, manifest, walker, problems)
    if (pkg) packages.push(pkg)
  }
  return packages
}

async function extractPackage(
  root: string,
  manifest: PackageManifest,
  walker: ReturnType<typeof createWalker>,
  problems: Set<string>,
): Promise<ApiPackage | undefined> {
  const packageDir = join(root, manifest.dir)
  const before = new Set(problems)
  const resolved = manifest.entries.flatMap((entry) => {
    const file = entry.targets
      .map((target) => resolveEntry(packageDir, target))
      .find((found) => found !== undefined)
    return file ? [{ subpath: entry.subpath, file }] : []
  })
  if (!resolved.length)
    resolved.push(...manifest.wildcards.flatMap((wildcard) => expandWildcard(packageDir, wildcard)))
  const entries: ApiEntry[] = []
  for (const { subpath, file } of resolved) {
    // oxlint-disable-next-line no-await-in-loop -- entries share cached modules
    const symbols = [...(await walker.exportsOf(file)).values()].toSorted(bySymbol)
    entries.push({
      subpath,
      file: relative(root, file).split('\\').join('/'),
      symbols: symbols.slice(0, extractLimits.symbols),
      ...(symbols.length > extractLimits.symbols
        ? { truncated: symbols.length - extractLimits.symbols }
        : {}),
    })
  }
  if (!entries.length) return undefined
  const own = [...problems].filter((problem) => !before.has(problem))
  return {
    name: manifest.name,
    ...(manifest.version ? { version: manifest.version } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    private: manifest.private,
    dir: manifest.dir,
    entries,
    ...(own.length ? { problems: own.slice(0, 20) } : {}),
  }
}
