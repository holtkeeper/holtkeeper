import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { scanImports, toDistPath } from './files.ts'

/** One way into the app and the files it loads. Paths are relative to the dist directory. */
export interface Entrypoint {
  name: string
  /** Files loaded on first visit: the HTML page, entry scripts and styles, static imports. */
  initial: string[]
  /** Files loaded later through dynamic imports. */
  lazy: string[]
}

/**
 * Finds the entrypoints of a build. Returns `undefined` or an empty list when the build carries
 * nothing the resolver understands, so resolvers can be chained with `firstEntrypoints`.
 */
export interface EntrypointResolver {
  /** Short id for diagnostics, e.g. `vite-manifest`. */
  name: string
  /** Bundler the resolver recognizes, used as the tool hint when it finds entrypoints. */
  tool?: string
  resolve(distDir: string): Promise<Entrypoint[] | undefined>
}

/** A resolver that returns the result of the first resolver that finds any entrypoints. */
export function firstEntrypoints(...resolvers: EntrypointResolver[]): EntrypointResolver & {
  /** The resolver that answered the last `resolve` call. */
  readonly matched: EntrypointResolver | undefined
} {
  let matched: EntrypointResolver | undefined
  return {
    name: resolvers.map((resolver) => resolver.name).join('|'),
    get matched() {
      return matched
    },
    async resolve(distDir) {
      matched = undefined
      for (const resolver of resolvers) {
        const found = await resolver.resolve(distDir)
        if (found?.length) {
          matched = resolver
          return found
        }
      }
      return undefined
    },
  }
}

/**
 * Completes entrypoints by following ES module imports in their JS files: static imports join
 * `initial`, dynamic `import()` targets and their static imports join `lazy`. Resolvers that only
 * know the entry files (HTML pages, globs) rely on this; complete lists pass through unchanged.
 */
export async function followImports(
  distDir: string,
  entrypoints: Entrypoint[],
  files: ReadonlySet<string>,
): Promise<Entrypoint[]> {
  const cache = new Map<string, Promise<{ static: string[]; dynamic: string[] }>>()
  const importsOf = (file: string) => {
    let found = cache.get(file)
    if (!found) {
      found = /\.[cm]?js$/.test(file)
        ? readFile(join(distDir, file), 'utf8').then((code) => {
            const raw = scanImports(code)
            const dir = posix.dirname(file)
            return {
              static: raw.static.flatMap((ref) => toDistPath(ref, dir, files) ?? []),
              dynamic: raw.dynamic.flatMap((ref) => toDistPath(ref, dir, files) ?? []),
            }
          })
        : Promise.resolve({ static: [], dynamic: [] })
      cache.set(file, found)
    }
    return found
  }

  const closure = async (roots: Iterable<string>, into: Set<string>, dynamic: Set<string>) => {
    const queue = [...roots]
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (into.has(file)) continue
      into.add(file)
      const imports = await importsOf(file)
      queue.push(...imports.static)
      for (const target of imports.dynamic) dynamic.add(target)
    }
  }

  return Promise.all(
    entrypoints.map(async (entry) => {
      const initial = new Set<string>()
      const pending = new Set<string>()
      await closure(entry.initial, initial, pending)
      const lazy = new Set<string>()
      for (const file of entry.lazy) pending.add(file)
      for (;;) {
        const next = [...pending].filter((file) => !initial.has(file) && !lazy.has(file))
        if (!next.length) break
        pending.clear()
        const reached = new Set<string>()
        await closure(next, reached, pending)
        for (const file of reached) if (!initial.has(file)) lazy.add(file)
      }
      return { name: entry.name, initial: [...initial], lazy: [...lazy] }
    }),
  )
}
