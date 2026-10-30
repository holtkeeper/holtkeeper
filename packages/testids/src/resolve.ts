import { dirname, join, normalize } from 'node:path/posix'

/** What one module declares that matters for resolving components to native tags. */
export interface ModuleInfo {
  /** Local name → what it styles: a native tag (`button`) or another component (`Base`, `S.Link`). */
  definitions: Map<string, string>
  /** Local name → where it comes from; `name` is the exported name, `default` or `*`. */
  imports: Map<string, { from: string; name: string }>
  /** Exported name → local name. */
  exports: Map<string, string>
  /** `export … from`: `names` maps exported → imported names; absent for `export *`. */
  reexports: { from: string; names?: Map<string, string> }[]
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Reads a module's styled definitions, imports and exports with regular expressions. A styled
 * definition is `const X = <factory>.tag`, `<factory>('tag')` or `<factory>(Other)`, as written
 * with linaria, styled-components, emotion, MUI, chakra or tailwind-styled-components.
 */
export function parseModule(text: string, factories: readonly string[]): ModuleInfo {
  const info: ModuleInfo = {
    definitions: new Map(),
    imports: new Map(),
    exports: new Map(),
    reexports: [],
  }
  if (factories.length) {
    const factory = factories.map(escape).join('|')
    const target = String.raw`(?:${factory})\s*(?:\.\s*([A-Za-z][\w]*)|\(\s*(?:['"]([A-Za-z][\w-]*)['"]|([A-Za-z_$][\w$.]*)))`
    const named = new RegExp(
      String.raw`(?:^|[^\w$.])(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*${target}`,
      'gm',
    )
    for (const match of text.matchAll(named)) {
      const [, exported, name, member, literal, component] = match
      const styled = member ?? literal ?? component
      if (!name || !styled) continue
      info.definitions.set(name, styled)
      if (exported) info.exports.set(name, name)
    }
    const fallback = new RegExp(String.raw`export\s+default\s+${target}`, 'g')
    for (const [, member, literal, component] of text.matchAll(fallback)) {
      const styled = member ?? literal ?? component
      if (styled) info.definitions.set('default', styled)
    }
  }

  for (const [, clause = '', from = ''] of text.matchAll(
    /\bimport\s+(?:type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    const braces = /\{([^}]*)\}/.exec(clause)
    for (const item of braces?.[1]?.split(',') ?? []) {
      const parts = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(item)
      if (parts?.[1]) info.imports.set(parts[2] ?? parts[1], { from, name: parts[1] })
    }
    for (const item of clause.replace(/\{[^}]*\}/, '').split(',')) {
      const trimmed = item.trim()
      const namespace = /^\*\s+as\s+([\w$]+)$/.exec(trimmed)
      if (namespace?.[1]) info.imports.set(namespace[1], { from, name: '*' })
      else if (/^[\w$]+$/.test(trimmed)) info.imports.set(trimmed, { from, name: 'default' })
    }
  }

  for (const [, list = '', from] of text.matchAll(
    /\bexport\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g,
  )) {
    const names = new Map<string, string>()
    for (const item of list.split(',')) {
      const parts = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(item)
      if (parts?.[1]) names.set(parts[2] ?? parts[1], parts[1])
    }
    if (from) info.reexports.push({ from, names })
    else for (const [exported, local] of names) info.exports.set(exported, local)
  }
  for (const [, from] of text.matchAll(/\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g))
    if (from) info.reexports.push({ from })
  if (info.definitions.has('default')) info.exports.set('default', 'default')
  for (const [, name] of text.matchAll(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm))
    if (name && !info.exports.has('default')) info.exports.set('default', name)
  return info
}

/** How `createResolver` maps components to native tags. */
export interface ResolverOptions {
  /** Every file of the project, relative and `/`-separated, for resolving import paths. */
  files: ReadonlySet<string>
  /** Reads a project file; `undefined` when it cannot be read. */
  read: (file: string) => Promise<string | undefined>
  /** Factory names whose results are styled native tags, e.g. `styled`, `tw`. */
  factories: readonly string[]
  /**
   * Component name (or `*` pattern, matched against the whole name and its last `.` segment) → the
   * native tag it renders, e.g. `{ Button: 'button', 'el-button': 'button' }`. Checked first.
   */
  components: Readonly<Record<string, string>>
  /** Import prefix → project folder, e.g. `{ '@/': 'src/' }`. */
  aliases: Readonly<Record<string, string>>
}

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte']
const MAX_DEPTH = 12

const globRegex = (pattern: string) => new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`)

/**
 * Resolves a tag name used in a file to the native tag it renders, following styled definitions
 * through imports, namespace imports (`<S.Button>`), re-exports and barrels. Lower-case names
 * are native already. Returns `undefined` for components it cannot see through.
 */
export function createResolver(options: ResolverOptions) {
  const modules = new Map<string, Promise<ModuleInfo | undefined>>()
  const mapped = Object.entries(options.components).map(
    ([pattern, tag]) => [globRegex(pattern), tag] as const,
  )

  const moduleOf = (file: string) => {
    let info = modules.get(file)
    if (!info) {
      info = options
        .read(file)
        .then((text) => (text === undefined ? undefined : parseModule(text, options.factories)))
      modules.set(file, info)
    }
    return info
  }

  const locate = (from: string, spec: string): string | undefined => {
    let base: string | undefined
    if (spec.startsWith('.')) base = normalize(join(dirname(from), spec))
    else
      for (const [prefix, folder] of Object.entries(options.aliases))
        if (spec.startsWith(prefix)) {
          base = normalize(join(folder, spec.slice(prefix.length)))
          break
        }
    if (!base) return undefined
    const stem = base.replace(/\.[cm]?js$/, '')
    const candidates = [
      base,
      ...EXTENSIONS.map((ext) => stem + ext),
      ...EXTENSIONS.map((ext) => `${base}/index${ext}`),
    ]
    return candidates.find((candidate) => options.files.has(candidate))
  }

  const fromConfig = (name: string) => {
    const last = name.slice(name.lastIndexOf('.') + 1)
    return mapped.find(([pattern]) => pattern.test(name) || pattern.test(last))?.[1]
  }

  async function exported(file: string, name: string, depth: number): Promise<string | undefined> {
    if (depth > MAX_DEPTH) return undefined
    const info = await moduleOf(file)
    if (!info) return undefined
    const local = info.exports.get(name)
    if (local) return resolveIn(local, file, depth + 1)
    for (const re of info.reexports) {
      const target = locate(file, re.from)
      if (!target) continue
      if (re.names) {
        const original = re.names.get(name)
        if (original) return exported(target, original, depth + 1)
        continue
      }
      // oxlint-disable-next-line no-await-in-loop
      const found = await exported(target, name, depth + 1)
      if (found) return found
    }
    return undefined
  }

  async function resolveIn(name: string, file: string, depth: number): Promise<string | undefined> {
    if (depth > MAX_DEPTH) return undefined
    const configured = fromConfig(name)
    if (configured) return configured
    if (/^[a-z][a-z0-9]*$/.test(name)) return name
    const dot = name.indexOf('.')
    const info = await moduleOf(file)
    if (dot > 0) {
      const head = name.slice(0, dot)
      const member = name.slice(dot + 1)
      if (options.factories.includes(head) && /^[a-z][a-z0-9]*$/.test(member)) return member
      const namespace = info?.imports.get(head)
      if (namespace?.name !== '*') return undefined
      const target = locate(file, namespace.from)
      return target ? exported(target, member, depth + 1) : undefined
    }
    if (!info) return undefined
    const definition = info.definitions.get(name)
    if (definition) return resolveIn(definition, file, depth + 1)
    const imported = info.imports.get(name)
    if (!imported || imported.name === '*') return undefined
    const target = locate(file, imported.from)
    return target ? exported(target, imported.name, depth + 1) : undefined
  }

  return (name: string, file: string) => resolveIn(name, file, 0)
}
