import { goRoot } from './go.ts'
import { JS_LOCKFILES, npmRoot } from './npm.ts'
import {
  Files,
  baseName,
  byText,
  dirOf,
  errorText,
  finishRoot,
  inRoot,
  relativeTo,
  skippedDir,
} from './shared.ts'
import type {
  DependencyDiff,
  DependencyEcosystem,
  DependencyFilesReader,
  DependencyRoot,
} from './types.ts'

const DEFAULT_MAX_ROOTS = 20

/** A diff with no roots, for when there is nothing to compare. */
export function emptyDependencyDiff(): DependencyDiff {
  return { roots: [], skipped: 0, partial: false }
}

async function hasLockfile(files: Files, dir: string, changed: ReadonlySet<string>) {
  for (const file of JS_LOCKFILES) if (changed.has(inRoot(dir, file))) return true
  const found = await Promise.all(
    [...JS_LOCKFILES].flatMap((file) =>
      (['to', 'from'] as const).map((side) => files.read(inRoot(dir, file), side)),
    ),
  )
  return found.some((text) => text !== undefined)
}

async function npmRoots(files: Files, paths: readonly string[]) {
  const changed = new Set(paths)
  const probed = new Map<string, Promise<boolean>>()
  const probe = (dir: string) => {
    let found = probed.get(dir)
    if (!found) {
      found = hasLockfile(files, dir, changed)
      probed.set(dir, found)
    }
    return found
  }
  const rootOf = async (start: string): Promise<string> => {
    for (let current = start; ; current = dirOf(current)) {
      // oxlint-disable-next-line no-await-in-loop -- the nearest lockfile wins
      if (await probe(current)) return current
      if (current === '') return start
    }
  }
  const roots = new Map<string, Set<string>>()
  for (const path of paths) {
    const name = baseName(path)
    if (skippedDir(path) || (name !== 'package.json' && !JS_LOCKFILES.has(name))) continue
    const lockfile = name !== 'package.json'
    // oxlint-disable-next-line no-await-in-loop -- probes are cached per directory
    const root = lockfile ? dirOf(path) : await rootOf(dirOf(path))
    const manifests = roots.get(root) ?? new Set<string>()
    if (!lockfile) manifests.add(relativeTo(root, dirOf(path)))
    roots.set(root, manifests)
  }
  return roots
}

/**
 * Dependency changes between the two sides of `files`: one root per lockfile root or Go module
 * whose `package.json`, lockfile, `go.mod` or `go.sum` changed (`node_modules`, `vendor` and
 * `testdata` skipped). A `package.json` belongs to the nearest directory upward with a supported
 * lockfile at either side. Direct changes come from the manifests with the versions the lockfile
 * resolves; transitive ones from the whole lockfile or `go.sum`. Reads each file at most once per
 * side, never throws (read and parse failures land in the root's `errors`), and is deterministic.
 * Roots without any change or error (a `package.json` edit outside its dependencies) are left out.
 * At most `maxRoots` roots are computed; the rest are counted in `skipped`. `partial` passes on
 * that the caller's file list was incomplete.
 */
export async function diffDependencies(
  input: DependencyFilesReader & { maxRoots?: number; partial?: boolean },
): Promise<DependencyDiff> {
  const files = new Files(input)
  const paths = [
    ...new Set(input.files.flatMap((file) => [file.newPath, file.oldPath]).filter(Boolean)),
  ].toSorted(byText)
  const npm = await npmRoots(files, paths)
  const goDirs = [
    ...new Set(
      paths
        .filter((path) => !skippedDir(path) && ['go.mod', 'go.sum'].includes(baseName(path)))
        .map(dirOf),
    ),
  ]
  const all: {
    path: string
    ecosystem: DependencyEcosystem
    run: () => Promise<DependencyRoot>
  }[] = [
    ...[...npm].map(([path, manifests]) => ({
      path,
      ecosystem: 'npm' as const,
      run: () => npmRoot(files, { path, manifests }),
    })),
    ...goDirs.map((path) => ({
      path,
      ecosystem: 'go' as const,
      run: () => goRoot(files, path),
    })),
  ].toSorted((a, b) => byText(a.path, b.path) || byText(a.ecosystem, b.ecosystem))
  const max = Math.max(0, input.maxRoots ?? DEFAULT_MAX_ROOTS)
  const roots: DependencyRoot[] = []
  for (const entry of all.slice(0, max))
    roots.push(
      // oxlint-disable-next-line no-await-in-loop -- lockfiles are large; one root at a time
      await entry.run().catch((error: unknown) =>
        finishRoot({
          path: entry.path,
          ecosystem: entry.ecosystem,
          direct: [],
          transitive: [],
          errors: [`could not compute: ${errorText(error)}`],
        }),
      ),
    )
  return {
    roots: roots.filter(
      (root) =>
        root.direct.length ||
        root.counts.transitiveAdded ||
        root.counts.transitiveRemoved ||
        root.counts.transitiveUpdated ||
        root.errors.length,
    ),
    skipped: Math.max(0, all.length - max),
    partial: input.partial === true,
  }
}
