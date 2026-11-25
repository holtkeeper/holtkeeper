import { posix } from 'node:path'

import type {
  DependencyChangeKind,
  DependencyFilesReader,
  DependencyRoot,
  DirectDependencyChange,
  TransitiveDependencyChange,
} from './types.ts'

export type Side = 'from' | 'to'

const MAX_TRANSITIVE = 500

export const baseName = (path: string) => path.split('/').at(-1) ?? ''
export const dirOf = (path: string) => {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}
export const inRoot = (root: string, path: string) => (root ? posix.join(root, path) : path)
export const relativeTo = (root: string, dir: string) =>
  (root ? posix.relative(root, dir) : dir) || '.'
export const skippedDir = (path: string) => /(^|\/)(node_modules|vendor|testdata)\//.test(path)
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
export const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Reads each file at most once per side and remembers failed reads. */
export class Files {
  readonly #reader: DependencyFilesReader
  readonly #cache = new Map<string, Promise<string | undefined>>()
  readonly failures = new Map<string, string>()

  constructor(reader: DependencyFilesReader) {
    this.#reader = reader
  }

  read(path: string, side: Side): Promise<string | undefined> {
    const key = `${side}\0${path}`
    let cached = this.#cache.get(key)
    if (!cached) {
      cached = Promise.resolve()
        .then(() => this.#reader.read(path, side))
        .catch((error: unknown) => {
          this.failures.set(key, `could not read ${path} at ${side}: ${errorText(error)}`)
          return undefined
        })
      this.#cache.set(key, cached)
    }
    return cached
  }

  failuresOf(paths: readonly string[]): string[] {
    return paths.flatMap((path) =>
      (['from', 'to'] as const).flatMap((side) => {
        const failure = this.failures.get(`${side}\0${path}`)
        return failure ? [failure] : []
      }),
    )
  }
}

export function transitiveChanges(
  from: ReadonlyMap<string, readonly string[]> | undefined,
  to: ReadonlyMap<string, readonly string[]> | undefined,
  direct: ReadonlySet<string>,
): TransitiveDependencyChange[] {
  const changes: TransitiveDependencyChange[] = []
  const names = new Set([...(from?.keys() ?? []), ...(to?.keys() ?? [])])
  for (const name of names) {
    if (direct.has(name)) continue
    const before = from?.get(name)
    const after = to?.get(name)
    if (before && after) {
      if (before.join('\0') !== after.join('\0'))
        changes.push({ name, change: 'updated', from: [...before], to: [...after] })
    } else if (after) changes.push({ name, change: 'added', to: [...after] })
    else if (before) changes.push({ name, change: 'removed', from: [...before] })
  }
  return changes.toSorted((a, b) => byText(a.name, b.name))
}

const count = (items: readonly { change: DependencyChangeKind }[], kind: DependencyChangeKind) =>
  items.filter((item) => item.change === kind).length

export function finishRoot(
  root: Omit<DependencyRoot, 'counts' | 'transitiveCapped'>,
): DependencyRoot {
  const direct = root.direct.toSorted(
    (a: DirectDependencyChange, b: DirectDependencyChange) =>
      byText(a.workspace, b.workspace) || byText(a.name, b.name) || byText(a.field, b.field),
  )
  const counts = {
    added: count(direct, 'added'),
    removed: count(direct, 'removed'),
    updated: count(direct, 'updated'),
    transitiveAdded: count(root.transitive, 'added'),
    transitiveRemoved: count(root.transitive, 'removed'),
    transitiveUpdated: count(root.transitive, 'updated'),
  }
  const capped = root.transitive.length > MAX_TRANSITIVE
  return {
    ...root,
    direct,
    transitive: capped ? root.transitive.slice(0, MAX_TRANSITIVE) : root.transitive,
    ...(capped ? { transitiveCapped: true } : {}),
    counts,
  }
}
