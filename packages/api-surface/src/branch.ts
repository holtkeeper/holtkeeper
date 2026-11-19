import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'

import {
  type Bump,
  diffPackage,
  normalizeSignature,
  type PackageDiff,
  versionBump,
} from './diff.ts'
import { extractApi } from './extract.ts'
import { extractGoApi } from './go.ts'
import type { ApiEcosystem, ApiPackage, ApiSymbol } from './model.ts'
import { findPackages } from './packages.ts'
import { importPath } from './render.ts'

/** Options of `branchApiChanges`. */
export interface BranchApiOptions {
  /** Checkout at the merge request head. */
  dir: string
  /** Commit the merge request is compared against (the diff base). */
  baseSha: string
  /** Changed file paths (relative to dir) of the merge request. */
  changedFiles: readonly string[]
  runner: CommandRunner
  signal?: AbortSignal
  /** Cap of the rendered section in characters, default 6000. */
  maxChars?: number
  /** Optional filter: package names other repositories import; when given, only these packages are reported. */
  consumed?: (name: string, ecosystem: 'npm' | 'Go') => boolean | Promise<boolean>
}

/** Heading of the section `branchApiChanges` renders. */
export const branchApiHeading = '## Public API changes (computed: base → head)'

const instruction =
  'For removed or changed exports call package_usage (with `export` for the code of the uses) to see which repositories break; report at the changed declaration.'

const gitTimeoutMs = 120_000
const maxSignature = 300

const normalizePath = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '')

const inside = (dir: string, file: string) => dir === '.' || file.startsWith(`${dir}/`)

const ecosystemOf = (pkg: ApiPackage): 'npm' | 'Go' => (pkg.ecosystem === 'Go' ? 'Go' : 'npm')

/** Changed npm package folders: each changed file counts for the deepest package containing it. */
async function touchedNpmPackages(dir: string, files: readonly string[]): Promise<Set<string>> {
  const manifests = await findPackages(dir)
  const names = new Set<string>()
  for (const file of files) {
    const owner = manifests
      .filter((manifest) => inside(manifest.dir, file))
      .toSorted((a, b) => b.dir.length - a.dir.length)[0]
    if (owner) names.add(owner.name)
  }
  return names
}

/** Folders of changed Go sources that can change an API (test files cannot). */
const touchedGoDirs = (files: readonly string[]) =>
  new Set(
    files
      .filter((file) => file.endsWith('.go') && !file.endsWith('_test.go'))
      .map((file) => posix.dirname(file)),
  )

interface Side {
  npm: ApiPackage[]
  go: ApiPackage[]
}

async function extractSide(
  dir: string,
  npmNames: readonly string[],
  goNames: readonly string[],
): Promise<Side> {
  const npm = npmNames.length
    ? (await extractApi({ dir, packages: npmNames })).filter((pkg) => npmNames.includes(pkg.name))
    : []
  const go = goNames.length
    ? (await extractGoApi({ dir, packages: goNames })).packages.filter((pkg) =>
        goNames.includes(pkg.name),
      )
    : []
  return { npm, go }
}

async function headPackages(options: BranchApiOptions): Promise<ApiPackage[]> {
  const files = options.changedFiles.map(normalizePath).filter(Boolean)
  const npmNames = [...(await touchedNpmPackages(options.dir, files))]
  options.signal?.throwIfAborted()
  const npm = npmNames.length
    ? (await extractApi({ dir: options.dir, packages: npmNames })).filter((pkg) =>
        npmNames.includes(pkg.name),
      )
    : []
  options.signal?.throwIfAborted()
  const goDirs = touchedGoDirs(files)
  const go = goDirs.size
    ? (await extractGoApi({ dir: options.dir })).packages.filter((pkg) => goDirs.has(pkg.dir))
    : []
  const touched: ApiPackage[] = []
  for (const pkg of [...npm, ...go]) {
    // oxlint-disable-next-line no-await-in-loop -- the filter may query a store; few packages
    if (!options.consumed || (await options.consumed(pkg.name, ecosystemOf(pkg)))) touched.push(pkg)
  }
  return touched
}

/** Runs `use` on a detached worktree of `sha`; `undefined` when it cannot be created. */
async function withBaseWorktree<T>(
  options: BranchApiOptions,
  use: (dir: string) => Promise<T>,
): Promise<T | undefined> {
  const { runner, dir, signal } = options
  const run = (command: string[]) =>
    runner.run(command, { cwd: dir, timeoutMs: gitTimeoutMs, ...(signal ? { signal } : {}) })
  const parent = await mkdtemp(join(tmpdir(), 'holtkeeper-api-base-'))
  const worktree = join(parent, 'base')
  try {
    const added = await run(['git', 'worktree', 'add', '--detach', worktree, options.baseSha])
    if (added.exitCode !== 0) return undefined
    signal?.throwIfAborted()
    return await use(worktree)
  } finally {
    // Cleanup must not need the signal: an aborted run still removes its worktree.
    const cleanup = (command: string[]) =>
      runner.run(command, { cwd: dir, timeoutMs: gitTimeoutMs }).catch(() => undefined)
    await cleanup(['git', 'worktree', 'remove', '--force', worktree])
    await rm(parent, { recursive: true, force: true }).catch(() => undefined)
    await cleanup(['git', 'worktree', 'prune'])
  }
}

const required = (diff: PackageDiff): Bump =>
  diff.removed || diff.changed ? 'major' : diff.added || diff.deprecated ? 'minor' : 'none'

const rank: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 }

function versionLine(diff: PackageDiff, ecosystem: ApiEcosystem): string {
  const needs = required(diff)
  const why =
    needs === 'major'
      ? diff.removed
        ? 'exports were removed'
        : 'signatures changed (minor only if every change stays compatible, e.g. an optional parameter added)'
      : 'exports were only added or deprecated'
  const head = `Needs a **${needs}** release: ${why}.`
  if (ecosystem === 'Go')
    return `${head} Go versions come from git tags, not from the source${needs === 'major' ? '; a major release of a v1+ module needs a new /vN module path' : ''}.`
  if (!diff.from || !diff.to) return `${head} No version in package.json to compare.`
  const bumped = versionBump(diff.from, diff.to)
  if (bumped === undefined) return `${head} Version ${diff.from} → ${diff.to} is not semver.`
  if (bumped === 'none')
    return `${head} Version in package.json did not change (${diff.to}): needs a ${needs} bump.`
  const zero = diff.to.replace(/^v/, '').startsWith('0.')
  const enough = rank[bumped] >= rank[needs]
  return `${head} Version ${diff.from} → ${diff.to} is a ${bumped} bump${zero && bumped === 'major' ? ' (0.x minor)' : ''}: ${enough ? 'enough' : `too small, needs ${needs}`}.`
}

const code = (text: string) => {
  const flat = normalizeSignature(text)
  const short = flat.length > maxSignature ? `${flat.slice(0, maxSignature)}…` : flat
  const ticks = short.includes('`') ? '``' : '`'
  return `${ticks}${short.startsWith('`') ? ' ' : ''}${short}${short.endsWith('`') ? ' ' : ''}${ticks}`
}

const symbolIndex = (pkg: ApiPackage | undefined) => {
  const map = new Map<string, ApiSymbol>()
  for (const entry of pkg?.entries ?? [])
    for (const symbol of entry.symbols) map.set(`${entry.subpath}\u0000${symbol.name}`, symbol)
  return map
}

const where = (symbol: ApiSymbol | undefined, label: string) =>
  symbol ? ` ${label} \`${symbol.file}:${symbol.line}\`` : ''

function changeLines(diff: PackageDiff, base?: ApiPackage, head?: ApiPackage): string[] {
  const before = symbolIndex(base)
  const after = symbolIndex(head)
  return diff.changes.map((change) => {
    const key = `${change.subpath}\u0000${change.name}`
    const name =
      change.subpath === '.'
        ? change.name
        : `${importPath(diff.name, change.subpath)} → ${change.name}`
    const label = `\`${name}\` (${change.kind})`
    switch (change.change) {
      case 'removed':
        return `- removed ${label}${where(before.get(key), 'was at')}: ${code(change.before ?? '')}`
      case 'changed':
        return `- changed ${label}${where(after.get(key), 'at')}: ${code(change.before ?? '')} → ${code(change.after ?? '')}`
      case 'deprecated':
        return `- deprecated ${label}${where(after.get(key), 'at')}`
      default:
        return `- added ${label}${where(after.get(key), 'at')}: ${code(change.after ?? '')}`
    }
  })
}

interface Block {
  header: string[]
  changes: string[]
}

function render(blocks: readonly Block[], maxChars: number): string {
  const footer = `\n\n${instruction}`
  const lines = [branchApiHeading]
  let length = branchApiHeading.length + footer.length
  let skipped = 0
  const reserve = 40
  const fits = (line: string) => length + line.length + 1 + reserve <= maxChars
  for (const block of blocks) {
    const header = block.header.join('\n')
    if (skipped || !fits(`\n${header}`)) {
      skipped += block.changes.length
      continue
    }
    lines.push('', header)
    length += header.length + 2
    for (const line of block.changes) {
      if (skipped || !fits(line)) {
        skipped++
        continue
      }
      lines.push(line)
      length += line.length + 1
    }
  }
  if (skipped) lines.push(`… ${skipped} more change${skipped === 1 ? '' : 's'}`)
  return `${lines.join('\n')}${footer}`
}

/**
 * The public API changes a merge request makes, as a Markdown section for a review prompt: per
 * touched package (npm or Go) the removed, changed and added exports with `file:line`, the semver
 * bump they need and whether the package.json version follows. Only packages that contain a
 * changed file, have an entry point and pass `consumed` are compared; the base side is read from
 * a temporary git worktree of `baseSha` that is always removed afterwards. Nothing is stored.
 * Resolves to `undefined` when no such package is touched, nothing differs, or the base cannot be
 * checked out or read; it never rejects except when `signal` aborts. The section stays within
 * `maxChars` (default 6000), ending with "… N more changes" when cut.
 */
export async function branchApiChanges(options: BranchApiOptions): Promise<string | undefined> {
  options.signal?.throwIfAborted()
  try {
    const head = await headPackages(options)
    if (!head.length) return undefined
    options.signal?.throwIfAborted()
    const npmNames = head.filter((pkg) => ecosystemOf(pkg) === 'npm').map((pkg) => pkg.name)
    const goNames = head.filter((pkg) => ecosystemOf(pkg) === 'Go').map((pkg) => pkg.name)
    const base = await withBaseWorktree(options, (dir) => extractSide(dir, npmNames, goNames))
    if (!base) return undefined
    options.signal?.throwIfAborted()
    const baseByKey = new Map(
      [...base.npm, ...base.go].map((pkg) => [`${ecosystemOf(pkg)}\u0000${pkg.name}`, pkg]),
    )
    const blocks: Block[] = []
    for (const pkg of head.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const ecosystem = ecosystemOf(pkg)
      const old = baseByKey.get(`${ecosystem}\u0000${pkg.name}`)
      const diff = diffPackage(old, pkg)
      if (!diff.changes.length) continue
      const counts = `${diff.removed} removed, ${diff.changed} changed, ${diff.deprecated} deprecated, ${diff.added} added`
      blocks.push({
        header: [
          `### \`${pkg.name}\` (${ecosystem}${pkg.dir === '.' ? '' : `, folder \`${pkg.dir}\``})${old ? '' : ' — new package'}`,
          `${counts}. ${versionLine(diff, ecosystem)}`,
        ],
        changes: changeLines(diff, old, pkg),
      })
    }
    if (!blocks.length) return undefined
    return render(blocks, options.maxChars ?? 6000)
  } catch (error) {
    if (options.signal?.aborted) throw error
    return undefined
  }
}
