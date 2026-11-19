import type { ExternalFiles } from '@holtkeeper/agent'

import { type PackageToolsContext, packagesToolset } from './tools/packages.ts'

/** A dependency a path points into. */
export interface DependencyPath {
  /** Package name or Go import path; absent when the path names none exactly (a glob). */
  package?: string
  ecosystem: 'npm' | 'Go'
  /** Version the path itself names (the Go module cache does). */
  version?: string
  /** Path inside the package, `''` for the package folder itself. */
  rest: string
}

const GLOB = /[*?[\]{}]/

/**
 * The dependency `path` points into: a package under `node_modules` (dot folders such as `.bin`
 * and globs name none), a module in the Go module cache (`…/pkg/mod/<module>@v<version>/…`, with
 * its `!x` escapes undone) or a vendored Go package (`vendor/<host.tld>/<name>…` at the root,
 * `<owner>/<name>` on hosts that have owners); `undefined` for any other path, the repository's own `pkg/mod` and `vendor` folders
 * included.
 */
export function dependencyPath(path: string): DependencyPath | undefined {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  const modules = parts.lastIndexOf('node_modules')
  if (modules !== -1) {
    const [first = '', second = '', ...after] = parts.slice(modules + 1)
    const scoped = first.startsWith('@')
    const name = scoped ? `${first}/${second}` : first
    const rest = (scoped ? after : [second, ...after]).filter(Boolean).join('/')
    return name && !name.startsWith('.') && !GLOB.test(name) && (!scoped || second)
      ? { package: name, ecosystem: 'npm', rest }
      : { ecosystem: 'npm', rest: '' }
  }
  const cache = parts.findIndex((part, index) => part === 'mod' && parts[index - 1] === 'pkg')
  const after = cache === -1 ? [] : parts.slice(cache + 1).map(unescapeGo)
  const at = after.findIndex((part) => /@v\d/.test(part))
  if (at !== -1) {
    const [last = '', version = ''] = (after[at] ?? '').split('@')
    return {
      package: [...after.slice(0, at), last].join('/'),
      ecosystem: 'Go',
      ...(version && { version }),
      rest: after.slice(at + 1).join('/'),
    }
  }
  const depth = OWNER_HOSTS.has(parts[1] ?? '') ? 3 : 2
  if (parts[0] === 'vendor' && GO_HOST.test(parts[1] ?? '') && parts.length > depth) {
    const vendored = parts.slice(1)
    const file =
      vendored.length > depth && GO_FILE.test(vendored.at(-1) ?? '') ? vendored.at(-1) : undefined
    const folder = file ? vendored.slice(0, -1) : vendored
    return folder.some((part) => GLOB.test(part))
      ? { ecosystem: 'Go', rest: '' }
      : { package: folder.join('/'), ecosystem: 'Go', rest: file ?? '' }
  }
  return undefined
}

/** A segment of the Go module cache as written: `!x` stands for an upper-case `X`. */
const unescapeGo = (part: string) =>
  part.replace(/!([a-z])/g, (_, letter: string) => letter.toUpperCase())

/** Hosts whose module paths have an owner before the name (`host/owner/name`). */
const OWNER_HOSTS: ReadonlySet<string> = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])

/** Files a vendored Go package holds; a last path element such as `yaml.v3` is a package. */
const GO_FILE = /\.(go|s|h|c|cc|cpp|proto|mod|sum|txt|md|json|ya?ml)$/

/** The first path element of a Go module path: a host name, not a folder named like a file. */
const GO_HOST = /^(?!.*\.(?:js|mjs|cjs|ts|css|json|map|html|md)$)[a-z0-9-]+(\.[a-z0-9-]+)+$/

/** Paths of a published package that hold declarations or build output, not its source. */
const BUILT = /(^|\/)(dist|lib|build|out|types|typings|esm|cjs|umd)\/|\.d\.[cm]?ts$|\.min\.js$/

const NOT_INSTALLED = 'Dependencies are not installed in this checkout'

/**
 * `ExternalFiles` over the package tools: a read of a file inside a dependency the checkout does
 * not hold is answered from the package index at the version the task's repository uses (the
 * API for a package folder, its `package.json`, declarations and build output; the source file
 * otherwise), and a search there gets the calls to make instead. Without the docs of the library
 * index every read is answered with the API.
 */
export function externalFiles(context: PackageToolsContext): ExternalFiles {
  const tools = new Map(packagesToolset(context).tools.map((tool) => [tool.name, tool]))
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(name)
    if (!tool) return undefined
    try {
      return {
        text: await tool.run(input, { dir: process.cwd(), signal: new AbortController().signal }),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const source = tools.has('package_source')

  return {
    async read(path, lines) {
      const found = dependencyPath(path)
      if (!found?.package) return undefined
      const base = {
        package: found.package,
        ecosystem: found.ecosystem,
        ...(found.version && { version: found.version }),
      }
      const vendored = found.ecosystem === 'Go' && !found.version
      const api =
        !source ||
        vendored ||
        !found.rest ||
        found.rest === 'package.json' ||
        (found.ecosystem === 'npm' && BUILT.test(found.rest))
      const [name, input] = api
        ? (['package_api', base] as const)
        : ([
            'package_source',
            {
              ...base,
              path: found.rest,
              ...(lines?.offset && { start: lines.offset }),
              ...(lines?.offset && lines.limit && { end: lines.offset + lines.limit - 1 }),
            },
          ] as const)
      const answer = await call(name, input)
      if (answer === undefined) return undefined
      if ('error' in answer)
        return `${NOT_INSTALLED}, so \`${path}\` does not exist, and Holtkeeper's package index has nothing for it either: ${answer.error}`
      const { text } = answer
      return [
        `${NOT_INSTALLED}, so \`${path}\` does not exist. This is ${found.package} from Holtkeeper's package index instead (${name} ${JSON.stringify(input)}); call the package tools for more of it.`,
        text,
      ].join('\n\n')
    },
    hint(path) {
      const found = dependencyPath(path)
      if (!found) return undefined
      if (!found.package)
        return `${NOT_INSTALLED}, so there is nothing to find under \`${path}\`. Call find_packages for a package or export by name, then package_api${source ? ', package_source' : ''} for it.`
      const name = JSON.stringify(found.package)
      return `${NOT_INSTALLED}, so there is nothing under \`${path}\`. For ${found.package} call package_api { "package": ${name} } for its API${
        source
          ? `, package_source { "package": ${name}${found.rest && !(found.ecosystem === 'npm' && BUILT.test(found.rest)) ? `, "path": ${JSON.stringify(found.rest)}` : ''} } for its code`
          : ''
      } and package_usage for how repositories use it.`
    },
  }
}
