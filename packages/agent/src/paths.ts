import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Resolves symlinks of the longest existing prefix, so files about to be created resolve too. */
function realpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(realpath(parent), basename(path))
  }
}

/** Whether `path` (relative to `root` or absolute) stays inside `root` with symlinks resolved. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(realpath(root), realpath(resolve(root, path)))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The absolute path of `path` inside `root`; throws when it leaves `root`. */
export function resolveInside(root: string, path: string): string {
  if (!isInside(root, path)) throw new Error(`${path} is outside the working directory`)
  return resolve(root, path)
}
