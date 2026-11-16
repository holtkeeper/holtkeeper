import type { DiffFile, GitForge } from '@holtkeeper/forge'

import type {
  QaChange,
  QaChangeDetail,
  QaFileChange,
  TestIdFileChange,
  TestIdRef,
} from './model.ts'

/** At most this many files of a change are kept in its detail. */
const FILE_CAP = 300

type DiffForge = Pick<GitForge, 'compareCommits' | 'getMergeRequestDiff'>

/**
 * The diff of one change: the merge request's latest diff while it is open, else the commits
 * from `base` to `head`. Empty for a root commit or when the forge cannot diff.
 */
export async function changeDiff(forge: DiffForge, change: QaChange): Promise<DiffFile[]> {
  if (change.kind === 'open-merge-request' && change.mergeRequest) {
    if (!forge.getMergeRequestDiff) return []
    return (await forge.getMergeRequestDiff(change.repo.path, change.mergeRequest.id)).files
  }
  if (!change.base || !forge.compareCommits) return []
  return forge.compareCommits(change.repo.path, change.base, change.head)
}

const lines = (diff: string, sign: '+' | '-') =>
  diff
    .split('\n')
    .filter((line) => line.startsWith(sign) && !line.startsWith(`${sign}${sign}${sign} `))
    .map((line) => line.slice(1))

/** Added and deleted lines of a unified diff body. */
export function diffStat(diff: string): { additions: number; deletions: number } {
  return { additions: lines(diff, '+').length, deletions: lines(diff, '-').length }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Test attributes written on `text`: `name="value"`, `name='value'`, `name={'value'}` and bound
 * forms (`:name="expr"`, `[attr.name]="expr"`, `name={expr}`) as dynamic values. Each of
 * `attributes` also covers names extending it with `-` (`data-test` covers `data-test-id`),
 * case-insensitively.
 */
export function testIdsIn(text: string, attributes: readonly string[]): TestIdRef[] {
  if (attributes.length === 0) return []
  const names = attributes.map(escape).join('|')
  const regex = new RegExp(
    `(?<![\\w-])(?<bind>:|v-bind:|\\[attr\\.)?(?<name>(?:${names})(?:-[\\w-]+)?)\\]?\\s*=\\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|\\{\\s*(?:"(?<bdq>[^"]*)"|'(?<bsq>[^']*)'|\`(?<tpl>[^\`]*)\`|(?<expr>[^}]*))\\s*\\})`,
    'giu',
  )
  const found: TestIdRef[] = []
  for (const match of text.matchAll(regex)) {
    const groups = match.groups ?? {}
    const name = groups.name ?? ''
    const quoted = groups.dq ?? groups.sq
    if (quoted !== undefined) {
      const bound = groups.bind !== undefined || /\$\{|\{\{/u.test(quoted)
      found.push({ attribute: name, value: quoted, ...(bound ? { dynamic: true } : {}) })
      continue
    }
    const literal = groups.bdq ?? groups.bsq
    if (literal !== undefined) {
      found.push({ attribute: name, value: literal })
      continue
    }
    const template = groups.tpl
    if (template !== undefined) {
      found.push({
        attribute: name,
        value: template,
        ...(template.includes('${') ? { dynamic: true } : {}),
      })
      continue
    }
    const expression = groups.expr?.trim()
    if (expression) found.push({ attribute: name, value: expression, dynamic: true })
  }
  return found
}

const refKey = (ref: TestIdRef) => `${ref.attribute.toLowerCase()}\u0000${ref.value}`

/**
 * Test attributes one file's diff adds and removes. An attribute that is deleted on one line and
 * added on another (a moved or reformatted element) is neither.
 */
export function testIdChanges(
  file: string,
  diff: string,
  attributes: readonly string[],
): TestIdFileChange | undefined {
  const added = lines(diff, '+').flatMap((line) => testIdsIn(line, attributes))
  const removed = lines(diff, '-').flatMap((line) => testIdsIn(line, attributes))
  const addedKeys = new Set(added.map(refKey))
  const removedKeys = new Set(removed.map(refKey))
  const unique = (refs: TestIdRef[], other: Set<string>) => {
    const seen = new Set<string>()
    return refs.filter((ref) => {
      const key = refKey(ref)
      if (other.has(key) || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const change = {
    file,
    added: unique(added, removedKeys),
    removed: unique(removed, addedKeys),
  }
  return change.added.length || change.removed.length ? change : undefined
}

/**
 * What a change's diff touches: files with their line counts and the test attributes (named by
 * `attributes`) added and removed per file. Kept small enough to store; the diff itself is not.
 */
export function changeDetail(
  files: readonly DiffFile[],
  attributes: readonly string[],
): QaChangeDetail {
  const kept = files.slice(0, FILE_CAP)
  const fileChanges: QaFileChange[] = kept.map((file) => ({
    path: file.newPath || file.oldPath,
    ...(file.status === 'renamed' && file.oldPath !== file.newPath
      ? { oldPath: file.oldPath }
      : {}),
    status: file.status,
    ...diffStat(file.diff),
    ...(file.binary ? { binary: true } : {}),
  }))
  const testIds = kept.flatMap((file) => {
    const change = testIdChanges(file.newPath || file.oldPath, file.diff, attributes)
    return change ? [change] : []
  })
  const partial = files.length > FILE_CAP || files.some((file) => file.collapsed)
  return { files: fileChanges, testIds, ...(partial ? { partial: true } : {}) }
}

const skipped =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.sum|Cargo\.lock|composer\.lock|poetry\.lock|uv\.lock|Gemfile\.lock)$|\.(?:min\.(?:js|css)|map|snap|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip)$|(?:^|\/)(?:dist|build|vendor|node_modules|__snapshots__|generated)\//u

/**
 * The parts of diffs an agent reads to describe a change, within `budget` characters: source
 * files first in the order given, each cut to `perFile` characters; lockfiles, generated,
 * binary and asset files only by name. Files that did not fit are listed by name at the end.
 */
export function diffExcerpt(
  files: readonly DiffFile[],
  options: { budget?: number; perFile?: number } = {},
): string {
  const budget = options.budget ?? 40_000
  const perFile = options.perFile ?? 6_000
  const parts: string[] = []
  const omitted: string[] = []
  let used = 0
  for (const file of files) {
    const path = file.newPath || file.oldPath
    if (file.binary || file.collapsed || !file.diff || skipped.test(path)) {
      omitted.push(path)
      continue
    }
    const body = file.diff.length > perFile ? `${file.diff.slice(0, perFile)}\n… (cut)` : file.diff
    const part = `--- ${file.status} ${path}\n${body}`
    if (used + part.length > budget) {
      omitted.push(path)
      continue
    }
    used += part.length
    parts.push(part)
  }
  if (omitted.length)
    parts.push(`Not shown: ${omitted.slice(0, 50).join(', ')}${omitted.length > 50 ? ', …' : ''}`)
  return parts.join('\n\n')
}
