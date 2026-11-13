import { join, posix } from 'node:path'

import {
  type JsWorkspaces,
  type LockIndex,
  type Manifest,
  declaredDependencies,
  findLockfile,
  indexLockfile,
  lockfileOf,
  lockfiles,
  readJsWorkspaces,
  workspacesOf,
} from '@holtkeeper/depgraph-js'
import type { DiffFile } from '@holtkeeper/forge'
import { type GoMod, type GoSumEntry, parseGoMod, parseGoSum } from '@holtkeeper/go-source'

/** Heading of the computed section in the review prompt. */
export const DEPENDENCY_SECTION_TITLE = 'Dependency changes (computed from the lockfiles)'
/** Longest computed dependency section, in characters. */
export const DEPENDENCY_SECTION_MAX_CHARS = 8000

const MAX_ROOTS = 6
const MAX_LIST = 15
const MAX_TRANSITIVE = 10
const MAX_ISSUES = 20

/** Where the dependency section reads files: the head checkout and the merge request base. */
export interface DependencyFiles {
  /** Every changed file of the merge request, ignored, binary and collapsed ones included. */
  files: readonly DiffFile[]
  /** Checkout at the merge request head. */
  dir: string
  /** A file at the merge request base, `undefined` when it does not exist there. */
  readBase(path: string): Promise<string | undefined>
}

const JS_LOCKFILES = new Set(lockfiles.map((lockfile) => lockfile.file))
const baseName = (path: string) => path.split('/').at(-1) ?? ''
const dirOf = (path: string) => {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}
const inRoot = (root: string, path: string) => (root ? posix.join(root, path) : path)
const relativeTo = (root: string, dir: string) => (root ? posix.relative(root, dir) : dir) || '.'
const skippedDir = (path: string) => /(^|\/)(node_modules|vendor|testdata)\//.test(path)

const isManifest = (value: unknown): value is Manifest =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseManifest = (text: string | undefined): Manifest | undefined => {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isManifest(value) ? value : undefined
  } catch {
    return undefined
  }
}

const readHead = async (dir: string, path: string) => {
  const file = Bun.file(join(dir, path))
  return (await file.exists()) ? file.text() : undefined
}

const listed = (lines: readonly string[], max: number, unit: string) =>
  lines.length > max ? [...lines.slice(0, max), `- … ${lines.length - max} more ${unit}`] : lines

const LOCAL_RANGE = /^(workspace|file|link|portal|patch|catalog|npm|git\+?[a-z]*|github|https?):/

/** Ranges the lockfile check skips: local packages, aliases, git and URL sources, dist tags. */
const checkable = (range: string) =>
  !LOCAL_RANGE.test(range) && !range.includes('/') && /^[\s\d^~<>=*vxX]/.test(range)

const sameRange = (manifest: string, recorded: string) =>
  manifest.trim() ===
  (manifest.startsWith('npm:') ? recorded : recorded.replace(/^npm:/, '')).trim()

function satisfies(version: string, range: string): boolean | undefined {
  try {
    return Bun.semver.satisfies(version, range)
  } catch {
    return undefined
  }
}

const CHECKED_KINDS = new Set(['prod', 'dev', 'optional'])

/** The `package.json` dependencies of one workspace, by name, without peer-only ones. */
const dependenciesOf = (manifest: Manifest | undefined) =>
  new Map(
    declaredDependencies(manifest ?? {})
      .filter((dep) => CHECKED_KINDS.has(dep.kind))
      .map((dep) => [dep.name, dep] as const),
  )

const FIELD_OF = new Map([
  ['prod', 'dependencies'],
  ['dev', 'devDependencies'],
  ['optional', 'optionalDependencies'],
])
const fieldOf = (kind: string) => FIELD_OF.get(kind) ?? `${kind}Dependencies`

/** Issues of one workspace's `package.json` against the lockfile at head. */
function checkWorkspace(
  index: LockIndex,
  path: string,
  manifest: Manifest,
  workspaceNames: ReadonlySet<string>,
): { checked: number; issues: string[] } {
  const label = `${path === '.' ? '' : `${path}/`}package.json`
  const importer = index.importers.get(path)
  const issues: string[] = []
  let checked = 0
  const declared = dependenciesOf(manifest)
  for (const dep of declared.values()) {
    if (workspaceNames.has(dep.name) || !checkable(dep.range)) continue
    checked++
    const locked = importer?.dependencies.get(dep.name)
    if (!locked?.version) {
      issues.push(
        `- ${label} declares \`${dep.name}\` ${dep.range} (${fieldOf(dep.kind)}), but ${index.file} does not resolve it for this workspace: the lockfile is out of date.`,
      )
      continue
    }
    if (
      importer?.recorded &&
      locked.specifier !== undefined &&
      !sameRange(dep.range, locked.specifier)
    ) {
      issues.push(
        `- ${label} declares \`${dep.name}\` ${dep.range}, but ${index.file} recorded ${locked.specifier} (resolved ${locked.version}): the lockfile was not regenerated after the change.`,
      )
      continue
    }
    if (satisfies(locked.version, dep.range) === false)
      issues.push(
        `- ${index.file} resolves \`${dep.name}\` to ${locked.version}, outside the range ${dep.range} that ${label} declares.`,
      )
  }
  if (importer?.recorded) {
    const all = new Set(declaredDependencies(manifest).map((dep) => dep.name))
    for (const locked of importer.dependencies.values())
      if (locked.specifier !== undefined && !all.has(locked.name))
        issues.push(
          `- ${index.file} still records \`${locked.name}\` ${locked.specifier} for ${label}, which no longer declares it.`,
        )
  }
  return { checked, issues }
}

const versionOf = (index: LockIndex | undefined, path: string, name: string) =>
  index?.importers.get(path)?.dependencies.get(name)?.version

interface JsRoot {
  root: string
  manifests: Set<string>
  lockfileChanged: boolean
}

async function jsRoots(dir: string, paths: readonly string[]): Promise<JsRoot[]> {
  const roots = new Map<string, JsRoot>()
  const rootOf = async (start: string): Promise<string> => {
    for (let current = start; ; current = dirOf(current)) {
      for (const file of JS_LOCKFILES)
        // oxlint-disable-next-line no-await-in-loop -- the nearest lockfile wins
        if (await Bun.file(join(dir, inRoot(current, file))).exists()) return current
      if (current === '') return start
    }
  }
  for (const path of paths) {
    const name = baseName(path)
    if (skippedDir(path) || (name !== 'package.json' && !JS_LOCKFILES.has(name))) continue
    const lockfile = name !== 'package.json'
    // oxlint-disable-next-line no-await-in-loop -- few manifests per merge request
    const root = lockfile ? dirOf(path) : await rootOf(dirOf(path))
    const entry = roots.get(root) ?? { root, manifests: new Set(), lockfileChanged: false }
    if (lockfile) entry.lockfileChanged = true
    else entry.manifests.add(relativeTo(root, dirOf(path)))
    roots.set(root, entry)
  }
  return [...roots.values()].toSorted((a, b) => (a.root < b.root ? -1 : 1))
}

async function headWorkspaces(dir: string, root: string): Promise<JsWorkspaces | undefined> {
  try {
    return await readJsWorkspaces(join(dir, root))
  } catch {
    return undefined
  }
}

async function jsSection(input: DependencyFiles, entry: JsRoot): Promise<string[]> {
  const { dir } = input
  const readBase = (path: string) => input.readBase(path)
  const { root } = entry
  const title = `### ${root || '.'} (npm, yarn, pnpm or bun)`
  const lockfile =
    (await findLockfile(join(dir, root))) ??
    input.files
      .filter((file) => dirOf(file.oldPath) === root && file.status === 'deleted')
      .map((file) => lockfileOf(file.oldPath))
      .find((found) => found !== undefined)
  const workspaces = await headWorkspaces(dir, root)
  const headManifests = new Map<string, Manifest>()
  for (const workspace of workspaces ? [workspaces.root, ...workspaces.packages] : [])
    headManifests.set(workspace.path, workspace.manifest)
  const baseManifests = new Map<string, Manifest>()
  const read = await Promise.all(
    [...new Set(['.', ...entry.manifests])].map(async (path) => {
      const file = inRoot(root, posix.join(path, 'package.json'))
      const [head, base] = await Promise.all([
        headManifests.has(path) ? undefined : readHead(dir, file),
        readBase(file),
      ])
      return { path, head: parseManifest(head), base: parseManifest(base) }
    }),
  )
  for (const { path, head, base } of read) {
    if (head) headManifests.set(path, head)
    if (base) baseManifests.set(path, base)
  }

  const out = [title]
  if (!lockfile) {
    out.push('No lockfile next to these package.json files or above them; nothing to check.')
    return [
      ...out,
      ...manifestChanges(entry, headManifests, baseManifests, undefined, undefined).lines,
    ]
  }
  const lockPath = inRoot(root, lockfile.file)
  const [headText, baseText] = await Promise.all([readHead(dir, lockPath), readBase(lockPath)])
  out[0] = `### ${lockPath} (${lockfile.manager})`
  if (headText === undefined) {
    out.push(`${lockPath} is deleted by this merge request.`)
    return [
      ...out,
      ...manifestChanges(entry, headManifests, baseManifests, undefined, undefined).lines,
    ]
  }
  let head: LockIndex
  try {
    head = indexLockfile(lockfile, headText, workspaces ?? workspacesOf(headManifests))
  } catch (error) {
    out.push(`${lockPath} could not be parsed at head: ${errorText(error)}. Nothing was checked.`)
    return out
  }
  let base: LockIndex | undefined
  try {
    base =
      baseText === undefined
        ? undefined
        : indexLockfile(lockfile, baseText, workspacesOf(baseManifests))
  } catch {
    base = undefined
  }
  out.push(
    `${lockPath}: ${entry.lockfileChanged ? 'changed' : 'not changed'} by this merge request${baseText === undefined ? ' (new file)' : ''}; read in full at base and head (${head.packages.size} packages at head).`,
  )
  const manifests = manifestChanges(entry, headManifests, baseManifests, head, base)
  out.push(...manifests.lines)
  if (base) out.push(...resolutionChanges(head, base, manifests.reported))

  const workspaceNames = new Set(
    workspaces ? [workspaces.root, ...workspaces.packages].map((workspace) => workspace.name) : [],
  )
  const checkedPaths = entry.lockfileChanged ? [...headManifests.keys()] : [...entry.manifests]
  const issues: string[] = []
  let checked = 0
  for (const path of checkedPaths.toSorted()) {
    const manifest = headManifests.get(path)
    if (!manifest) continue
    const result = checkWorkspace(head, path, manifest, workspaceNames)
    checked += result.checked
    issues.push(...result.issues)
  }
  const scope = `${checkedPaths.length} package.json ${checkedPaths.length === 1 ? 'file' : 'files'} checked`
  if (issues.length)
    out.push(`Consistency problems at head (${scope}):`, ...listed(issues, MAX_ISSUES, 'problems'))
  else
    out.push(
      `Consistency: OK. ${lockPath} resolves all ${checked} registry dependencies of ${scope}, with the ranges package.json declares. Do not ask to add them to or update the lockfile.`,
    )
  return out
}

function manifestChanges(
  entry: JsRoot,
  headManifests: ReadonlyMap<string, Manifest>,
  baseManifests: ReadonlyMap<string, Manifest>,
  head: LockIndex | undefined,
  base: LockIndex | undefined,
): { lines: string[]; reported: Set<string> } {
  const lines: string[] = []
  const reported = new Set<string>()
  for (const path of [...entry.manifests].toSorted()) {
    const label = `${path === '.' ? '' : `${path}/`}package.json`
    const before = new Map(
      declaredDependencies(baseManifests.get(path) ?? {}).map((dep) => [
        `${dep.kind} ${dep.name}`,
        dep,
      ]),
    )
    const after = new Map(
      declaredDependencies(headManifests.get(path) ?? {}).map((dep) => [
        `${dep.kind} ${dep.name}`,
        dep,
      ]),
    )
    for (const [key, dep] of after) {
      const old = before.get(key)
      const locked = versionOf(head, path, dep.name)
      if (!old || old.range !== dep.range) reported.add(`${path} ${dep.name}`)
      if (!old)
        lines.push(
          `- ${label}: added ${fieldOf(dep.kind)} \`${dep.name}\` ${dep.range}${head ? (locked ? `, lockfile resolves ${locked}` : ', not resolved by the lockfile') : ''}`,
        )
      else if (old.range !== dep.range) {
        const was = versionOf(base, path, dep.name)
        lines.push(
          `- ${label}: ${fieldOf(dep.kind)} \`${dep.name}\` ${old.range} → ${dep.range}${locked ? `, lockfile ${was && was !== locked ? `${was} → ` : ''}${locked}` : head ? ', not resolved by the lockfile' : ''}`,
        )
      }
    }
    for (const [key, dep] of before)
      if (!after.has(key))
        lines.push(`- ${label}: removed ${fieldOf(dep.kind)} \`${dep.name}\` ${dep.range}`)
  }
  return {
    lines: lines.length
      ? ['package.json dependency changes:', ...listed(lines, MAX_LIST, 'changes')]
      : [],
    reported,
  }
}

const nameOf = (item: string) => item.slice(0, item.indexOf(' '))

const sample = (items: readonly string[], max: number) =>
  `${items.slice(0, max).join('; ')}${items.length > max ? `; … ${items.length - max} more` : ''}`

function resolutionChanges(
  head: LockIndex,
  base: LockIndex,
  reported: ReadonlySet<string>,
): string[] {
  const direct = new Set<string>()
  const changed: string[] = []
  for (const index of [base, head])
    for (const importer of index.importers.values())
      for (const name of importer.dependencies.keys()) direct.add(name)
  for (const [path, importer] of head.importers) {
    for (const [name, dep] of importer.dependencies) {
      if (reported.has(`${path} ${name}`)) continue
      const was = versionOf(base, path, name)
      if (dep.version && was && was !== dep.version && !dep.version.startsWith('workspace:'))
        changed.push(`- ${path === '.' ? '(root)' : path}: \`${name}\` ${was} → ${dep.version}`)
    }
  }
  const added: string[] = []
  const removed: string[] = []
  const bumped: string[] = []
  for (const [name, versions] of head.packages) {
    const old = base.packages.get(name)
    if (!old) added.push(`${name} ${versions.join(', ')}`)
    else if (old.join() !== versions.join())
      bumped.push(`${name} ${old.join(', ')} → ${versions.join(', ')}`)
  }
  for (const [name, versions] of base.packages)
    if (!head.packages.has(name)) removed.push(`${name} ${versions.join(', ')}`)
  const out: string[] = []
  if (changed.length)
    out.push(
      'Direct dependencies resolved to other versions (package.json range unchanged):',
      ...listed(changed, MAX_LIST, 'changes'),
    )
  if (!added.length && !removed.length && !bumped.length) {
    out.push('Lockfile packages: no package added, removed or changed.')
    return out
  }
  const split = (items: string[]) => ({
    direct: items.filter((item) => direct.has(nameOf(item))),
    transitive: items.filter((item) => !direct.has(nameOf(item))),
  })
  const groups = { added: split(added), removed: split(removed), changed: split(bumped) }
  out.push(
    `Lockfile packages: ${added.length} added, ${removed.length} removed, ${bumped.length} with other versions.`,
  )
  for (const [label, group] of Object.entries(groups))
    if (group.direct.length) out.push(`- direct, ${label}: ${sample(group.direct, MAX_LIST)}`)
  for (const [label, group] of Object.entries(groups))
    if (group.transitive.length)
      out.push(
        `- transitive, ${label} (${group.transitive.length}): ${sample(group.transitive, MAX_TRANSITIVE)}`,
      )
  return out
}

const sumKey = (entry: GoSumEntry) => `${entry.path} ${entry.version}`

async function goSection(input: DependencyFiles, moduleDir: string): Promise<string[]> {
  const modPath = inRoot(moduleDir, 'go.mod')
  const sumPath = inRoot(moduleDir, 'go.sum')
  const [headMod, baseMod, headSum, baseSum] = await Promise.all([
    readHead(input.dir, modPath),
    input.readBase(modPath),
    readHead(input.dir, sumPath),
    input.readBase(sumPath),
  ])
  const out = [`### ${modPath} (Go)`]
  if (headMod === undefined) {
    out.push(`${modPath} is deleted by this merge request.`)
    return out
  }
  const head = parseGoMod(headMod)
  const base = baseMod === undefined ? undefined : parseGoMod(baseMod)
  out.push(...requireChanges(head, base))
  const headEntries = headSum === undefined ? [] : parseGoSum(headSum)
  if (baseSum !== undefined || headSum !== undefined) {
    const before = new Set((baseSum === undefined ? [] : parseGoSum(baseSum)).map(sumKey))
    const after = new Set(headEntries.map(sumKey))
    const added = [...after].filter((item) => !before.has(item))
    const removed = [...before].filter((item) => !after.has(item))
    out.push(
      `go.sum: ${headSum === undefined ? 'missing at head' : `${added.length} module versions added, ${removed.length} removed`}${added.length ? ` (${added.slice(0, MAX_TRANSITIVE).join('; ')}${added.length > MAX_TRANSITIVE ? '; …' : ''})` : ''}.`,
    )
  }
  const sums = new Map<string, Set<GoSumEntry['kind']>>()
  for (const entry of headEntries) {
    const k = sumKey(entry)
    sums.set(k, (sums.get(k) ?? new Set()).add(entry.kind))
  }
  const issues: string[] = []
  let checked = 0
  for (const req of head.require) {
    const replace = head.replace.find(
      (r) => r.path === req.path && (!r.version || r.version === req.version),
    )
    if (replace?.local) continue
    const path = replace ? replace.to : req.path
    const version = replace?.toVersion ?? req.version
    checked++
    const kinds = sums.get(`${path} ${version}`)
    if (!kinds)
      issues.push(
        `- go.mod requires \`${path}\` ${version}, but go.sum has no entry for it: run \`go mod tidy\`.`,
      )
    else if (!req.indirect && !kinds.has('module'))
      issues.push(
        `- go.sum has only the go.mod hash of \`${path}\` ${version}, a direct requirement; building its packages needs the module hash (\`go mod tidy\`).`,
      )
  }
  if (issues.length)
    out.push('Consistency problems at head:', ...listed(issues, MAX_ISSUES, 'problems'))
  else
    out.push(
      `Consistency: OK. go.sum has entries for all ${checked} modules go.mod requires. Do not ask to update go.sum for them.`,
    )
  return out
}

const tag = (indirect?: true) => (indirect ? ' (indirect)' : '')

function requireChanges(head: GoMod, base: GoMod | undefined): string[] {
  const before = new Map((base?.require ?? []).map((req) => [req.path, req]))
  const after = new Map(head.require.map((req) => [req.path, req]))
  const lines: string[] = []
  for (const [path, req] of after) {
    const old = before.get(path)
    if (!old) lines.push(`- added \`${path}\` ${req.version}${tag(req.indirect)}`)
    else if (old.version !== req.version)
      lines.push(`- \`${path}\` ${old.version} → ${req.version}${tag(req.indirect)}`)
  }
  for (const [path, req] of before)
    if (!after.has(path)) lines.push(`- removed \`${path}\` ${req.version}${tag(req.indirect)}`)
  const direct = lines.filter((line) => !line.endsWith('(indirect)'))
  const indirect = lines.filter((line) => line.endsWith('(indirect)'))
  return lines.length
    ? ['go.mod require changes:', ...listed([...direct, ...indirect], MAX_LIST, 'changes')]
    : ['go.mod requires: unchanged.']
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The prompt section on dependency changes, computed from the files at the merge request base and
 * head: for every lockfile root or Go module whose manifest or lockfile the merge request touches,
 * the dependencies added, removed and changed in `package.json` / `go.mod`, what the lockfile
 * resolves now and what changed in it (direct dependencies listed, transitive ones counted with a
 * few examples), and a consistency check of the head: declared dependencies the lockfile does not
 * resolve, ranges it recorded differently, resolutions outside the range, entries for removed
 * dependencies, and `go.sum` entries missing for required modules. `''` when the merge request
 * touches no dependency file. Never throws: a root that cannot be read says so. At most
 * `DEPENDENCY_SECTION_MAX_CHARS` characters.
 */
export async function dependencySection(input: DependencyFiles): Promise<string> {
  const paths = [...new Set(input.files.flatMap((file) => [file.newPath, file.oldPath]))]
  const roots = await jsRoots(input.dir, paths)
  const goModules = [
    ...new Set(
      paths
        .filter((path) => !skippedDir(path) && ['go.mod', 'go.sum'].includes(baseName(path)))
        .map(dirOf),
    ),
  ].toSorted()
  if (!roots.length && !goModules.length) return ''
  const blocks: string[][] = []
  const all = [
    ...roots.map((root) => () => jsSection(input, root)),
    ...goModules.map((dir) => () => goSection(input, dir)),
  ]
  for (const run of all.slice(0, MAX_ROOTS))
    blocks.push(
      // oxlint-disable-next-line no-await-in-loop -- lockfiles are large; read one root at a time
      await run().catch((error: unknown) => [`Could not compute: ${errorText(error)}.`]),
    )
  if (all.length > MAX_ROOTS) blocks.push([`… ${all.length - MAX_ROOTS} more roots not computed.`])
  const intro = [
    `## ${DEPENDENCY_SECTION_TITLE}`,
    'Holtkeeper parsed the manifests and lockfiles at the merge request base and head in full; lockfiles are usually left out of the diff (ignored or marked binary). This section is authoritative: do not claim that a lockfile lacks a package, has a wrong entry or needs updating unless it says so below. Check other packages with lockfiles.resolve.',
  ].join('\n')
  const text = [intro, ...blocks.map((block) => block.join('\n'))].join('\n\n')
  if (text.length <= DEPENDENCY_SECTION_MAX_CHARS) return text
  const cut = text.slice(0, DEPENDENCY_SECTION_MAX_CHARS)
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n… section cut; use lockfiles.resolve for the rest.`
}
