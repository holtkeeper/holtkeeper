import { dirname, join } from 'node:path'

import { type QualityIssue, stableId } from '@holtkeeper/quality'

import type { DeadCodeFindings } from './findings.ts'

/**
 * Files knip calls unused although a tool loads them by name: stories (read by Storybook through
 * globs knip cannot always see) and tool configs (`*.config.*`, `.*rc.*`) of tools it has no
 * plugin for.
 */
const LOADED_BY_TOOLS = [
  /\.(?:stories|story)\.[cm]?[jt]sx?$/,
  /\.mdx$/,
  /(?:^|\/)[^/]+\.config\.[cm]?[jt]s$/,
  /(?:^|\/)\.[\w-]+rc\.[cm]?[jt]s$/,
]

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

async function manifest(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const json: unknown = await Bun.file(path).json()
    return typeof json === 'object' && json !== null ? { ...json } : undefined
  } catch {
    return undefined
  }
}

const names = (record: unknown) =>
  typeof record === 'object' && record !== null ? Object.keys(record) : []

/** Package directories from the file's own up to the project root, nearest first. */
function packageDirs(dir: string, file: string): string[] {
  const dirs: string[] = []
  for (let current = dirname(file); ; current = dirname(current)) {
    dirs.push(current === '.' ? dir : join(dir, current))
    if (current === '.' || current === '/' || current === '') break
  }
  return dirs
}

/**
 * The declared dependency that brings `name` along: a package listed in a `package.json` between
 * `file` and the project root whose own manifest depends on `name`.
 */
async function providerOf(dir: string, file: string, name: string): Promise<string | undefined> {
  for (const packageDir of packageDirs(dir, file)) {
    // oxlint-disable-next-line no-await-in-loop
    const own = await manifest(join(packageDir, 'package.json'))
    if (!own) continue
    for (const declared of DEPENDENCY_FIELDS.flatMap((field) => names(own[field]))) {
      for (const root of [packageDir, dir]) {
        // oxlint-disable-next-line no-await-in-loop
        const provided = await manifest(join(root, 'node_modules', declared, 'package.json'))
        if (!provided) continue
        if (DEPENDENCY_FIELDS.some((field) => names(provided[field]).includes(name)))
          return declared
        break
      }
    }
  }
  return undefined
}

const unlistedName = (issue: QualityIssue) => /^(\S+) is imported/.exec(issue.message)?.[1]

/**
 * Cuts knip's findings down to what is worth acting on:
 * - unused-file issues (and their deletions) for stories and tool configs are dropped;
 * - unlisted dependencies become one issue per package instead of one per importing file, and a
 *   package that a declared dependency already brings along (`some-kit` depending on `some-lib`)
 *   is reported as `deadcode/transitive-dependency` with severity `info`, naming that dependency.
 */
export async function refineFindings(
  findings: DeadCodeFindings,
  dir: string,
): Promise<DeadCodeFindings> {
  const dropped = new Set<string>()
  const kept: QualityIssue[] = []
  const unlisted = new Map<string, QualityIssue[]>()

  for (const issue of findings.issues) {
    const file = issue.file ?? ''
    if (
      issue.rule === 'deadcode/unused-file' &&
      LOADED_BY_TOOLS.some((pattern) => pattern.test(file))
    ) {
      if (issue.changeId) dropped.add(issue.changeId)
      continue
    }
    const name = issue.rule === 'deadcode/unlisted-dependency' ? unlistedName(issue) : undefined
    if (!name) {
      kept.push(issue)
      continue
    }
    const group = unlisted.get(name)
    if (group) group.push(issue)
    else {
      unlisted.set(name, [issue])
      kept.push(issue)
    }
  }

  const issues: QualityIssue[] = []
  for (const issue of kept) {
    const name = issue.rule === 'deadcode/unlisted-dependency' ? unlistedName(issue) : undefined
    const group = name ? unlisted.get(name) : undefined
    if (!name || !group) {
      issues.push(issue)
      continue
    }
    const where = group.length === 1 ? '' : ` (${group.length} files, first ${issue.file})`
    // oxlint-disable-next-line no-await-in-loop
    const provider = await providerOf(dir, issue.file ?? 'package.json', name)
    issues.push(
      provider
        ? {
            ...issue,
            id: stableId('knip', 'deadcode/transitive-dependency', name),
            rule: 'deadcode/transitive-dependency',
            severity: 'info',
            message: `${name} is imported${where} but only installed through ${provider}`,
            help: `List ${name} in package.json if the code relies on it directly, or import it through ${provider}.`,
          }
        : group.length === 1
          ? issue
          : {
              ...issue,
              id: stableId('knip', 'deadcode/unlisted-dependency', name),
              message: `${name} is imported${where} but not listed in package.json`,
            },
    )
  }

  return {
    issues,
    changes: findings.changes.filter((change) => !dropped.has(change.id)),
  }
}
