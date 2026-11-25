import { posix } from 'node:path'

import {
  type LockIndex,
  type Lockfile,
  type Manifest,
  declaredDependencies,
  indexLockfile,
  lockfiles,
  workspacesOf,
} from '@holtkeeper/depgraph-js'

import {
  type Files,
  type Side,
  errorText,
  finishRoot,
  inRoot,
  transitiveChanges,
} from './shared.ts'
import type { DependencyRoot, DependencySide, DirectDependencyChange } from './types.ts'

export const JS_LOCKFILES = new Set(lockfiles.map((lockfile) => lockfile.file))

/** A lockfile root and the workspaces below it whose `package.json` changed. */
export interface NpmRootInput {
  path: string
  /** Workspace directories relative to `path`, `.` for the root. */
  manifests: ReadonlySet<string>
}

type Declared = ReturnType<typeof declaredDependencies>[number]
type Field = DirectDependencyChange['field']

const SIDES = ['from', 'to'] as const

const isManifest = (value: unknown): value is Manifest =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseManifest(text: string): Manifest | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isManifest(value) ? value : undefined
  } catch {
    return undefined
  }
}

const fieldOf = (kind: string): Field =>
  kind === 'dev' || kind === 'optional' || kind === 'peer' ? kind : 'prod'

const isLocal = (side: DependencySide | undefined) =>
  side === undefined ||
  side.range?.startsWith('workspace:') === true ||
  side.version?.startsWith('workspace:') === true

const versionOf = (index: LockIndex | undefined, path: string, name: string) =>
  index?.importers.get(path)?.dependencies.get(name)?.version

const sideOf = (range: string | undefined, version: string | undefined): DependencySide => ({
  ...(range !== undefined ? { range } : {}),
  ...(version !== undefined ? { version } : {}),
})

async function chooseLockfile(
  files: Files,
  root: string,
  manifest: (side: Side) => Manifest | undefined,
): Promise<{ lockfile: Lockfile; at: Set<Side> } | undefined> {
  const present = (
    await Promise.all(
      lockfiles.map(async (lockfile) => {
        const texts = await Promise.all(
          SIDES.map((side) => files.read(inRoot(root, lockfile.file), side)),
        )
        return {
          lockfile,
          at: new Set(SIDES.filter((_, i) => texts[i] !== undefined)),
        }
      }),
    )
  ).filter((entry) => entry.at.size > 0)
  if (present.length < 2) return present[0]
  const managerOf = (side: Side) => {
    const value = manifest(side)?.packageManager
    return typeof value === 'string' ? value.split('@')[0] : undefined
  }
  const manager = managerOf('to') ?? managerOf('from')
  return (
    present.find((entry) => entry.lockfile.manager === manager) ??
    present.find((entry) => entry.at.has('to')) ??
    present[0]
  )
}

/** Direct and transitive changes of one npm lockfile root; never throws. */
export async function npmRoot(files: Files, input: NpmRootInput): Promise<DependencyRoot> {
  const root = input.path
  const errors: string[] = []
  const readPaths: string[] = []
  const manifests = { from: new Map<string, Manifest>(), to: new Map<string, Manifest>() }
  const readManifest = async (workspace: string, side: Side) => {
    const file = inRoot(root, posix.join(workspace, 'package.json'))
    readPaths.push(file)
    const text = await files.read(file, side)
    if (text === undefined) return undefined
    const manifest = parseManifest(text)
    if (!manifest) errors.push(`${file} could not be parsed at ${side}`)
    else manifests[side].set(workspace, manifest)
    return manifest
  }
  await Promise.all(
    [...new Set(['.', ...input.manifests])].flatMap((workspace) =>
      SIDES.map((side) => readManifest(workspace, side)),
    ),
  )

  const chosen = await chooseLockfile(files, root, (side) => manifests[side].get('.'))
  const lockPath = chosen ? inRoot(root, chosen.lockfile.file) : undefined
  const texts = { from: undefined as string | undefined, to: undefined as string | undefined }
  const indexes = {
    from: undefined as LockIndex | undefined,
    to: undefined as LockIndex | undefined,
  }
  const parseFailed = new Set<Side>()
  if (chosen && lockPath) {
    readPaths.push(lockPath)
    const [fromText, toText] = await Promise.all(SIDES.map((side) => files.read(lockPath, side)))
    texts.from = fromText
    texts.to = toText
    const shareable = chosen.lockfile.manager !== 'yarn'
    for (const side of SIDES) {
      const text = texts[side]
      if (text === undefined) continue
      if (side === 'to' && shareable && text === texts.from && !parseFailed.has('from')) {
        indexes.to = indexes.from
        continue
      }
      try {
        indexes[side] = indexLockfile(chosen.lockfile, text, workspacesOf(manifests[side]))
      } catch (error) {
        parseFailed.add(side)
        errors.push(`${lockPath} could not be parsed at ${side}: ${errorText(error)}`)
      }
    }
  }

  const lockChanged = texts.from !== texts.to
  const workspaces = new Set(input.manifests)
  if (lockChanged)
    for (const index of [indexes.from, indexes.to])
      for (const path of index?.importers.keys() ?? []) workspaces.add(path)

  const direct: DirectDependencyChange[] = []
  const directNames = new Set<string>()
  for (const index of [indexes.from, indexes.to])
    for (const importer of index?.importers.values() ?? [])
      for (const name of importer.dependencies.keys()) directNames.add(name)

  const push = (change: DirectDependencyChange) => {
    if (isLocal(change.from) && isLocal(change.to)) return
    direct.push(change)
  }

  for (const workspace of [...workspaces].toSorted()) {
    if (input.manifests.has(workspace)) {
      const key = (dep: Declared) => `${dep.kind}\0${dep.name}`
      const before = new Map(
        declaredDependencies(manifests.from.get(workspace) ?? {}).map((dep) => [key(dep), dep]),
      )
      const after = new Map(
        declaredDependencies(manifests.to.get(workspace) ?? {}).map((dep) => [key(dep), dep]),
      )
      for (const dep of [...before.values(), ...after.values()]) directNames.add(dep.name)
      for (const k of new Set([...before.keys(), ...after.keys()])) {
        const was = before.get(k)
        const now = after.get(k)
        const dep = now ?? was
        if (!dep) continue
        const fromVersion = was ? versionOf(indexes.from, workspace, dep.name) : undefined
        const toVersion = now ? versionOf(indexes.to, workspace, dep.name) : undefined
        const from = was ? sideOf(was.range, fromVersion) : undefined
        const to = now ? sideOf(now.range, toVersion) : undefined
        const base = { name: dep.name, field: fieldOf(dep.kind), workspace }
        if (!was) push({ ...base, change: 'added', ...(to ? { to } : {}) })
        else if (!now) push({ ...base, change: 'removed', ...(from ? { from } : {}) })
        else if (
          was.range !== now.range ||
          (fromVersion !== undefined && toVersion !== undefined && fromVersion !== toVersion)
        )
          push({ ...base, change: 'updated', ...(from ? { from } : {}), ...(to ? { to } : {}) })
      }
      continue
    }
    const before = indexes.from?.importers.get(workspace)?.dependencies
    const after = indexes.to?.importers.get(workspace)?.dependencies
    if (!before || !after) continue
    const moved = [...after.values()].filter((dep) => {
      const was = before.get(dep.name)?.version
      return dep.version !== undefined && was !== undefined && was !== dep.version
    })
    if (!moved.length) continue
    // oxlint-disable-next-line no-await-in-loop -- read only for workspaces with re-resolutions
    const manifest = await readManifest(workspace, 'to')
    const declared = manifest ? declaredDependencies(manifest) : undefined
    for (const dep of moved) {
      const fromVersion = before.get(dep.name)?.version
      const matches = declared
        ? declared.filter((entry) => entry.name === dep.name)
        : [{ name: dep.name, kind: 'prod', range: dep.specifier }]
      for (const entry of matches)
        push({
          name: dep.name,
          change: 'updated',
          field: fieldOf(entry.kind),
          workspace,
          from: sideOf(entry.range, fromVersion),
          to: sideOf(entry.range, dep.version),
        })
    }
  }

  const transitive =
    lockChanged && parseFailed.size === 0 && chosen
      ? transitiveChanges(indexes.from?.packages, indexes.to?.packages, directNames)
      : []

  return finishRoot({
    path: root,
    ecosystem: 'npm',
    ...(chosen ? { manager: chosen.lockfile.manager, lockfile: chosen.lockfile.file } : {}),
    direct,
    transitive,
    errors: [...new Set([...files.failuresOf([...new Set(readPaths)]), ...errors])],
  })
}
