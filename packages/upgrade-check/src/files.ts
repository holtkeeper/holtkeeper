import type { DiffFile } from '@holtkeeper/forge'
import { isRangeNoise } from '@holtkeeper/release'

/** A file changed between the two commits of a check, without its diff text. */
export interface ChangedFile {
  /** New path, or the old one when deleted. */
  path: string
  oldPath: string
  status: DiffFile['status']
  added: number
  deleted: number
  binary: boolean
}

/** A group of changed files one agent pass reads. */
export interface UpgradeArea {
  /** Directory keys of the files, e.g. `services/billing`; `(root)` for top-level files. */
  keys: string[]
  /** Default display name, from the keys. */
  name: string
  files: ChangedFile[]
}

/** Most areas a check is split into. */
export const MAX_AREAS = 8
/** Most files a check reads; the rest is skipped and the check is marked capped. */
export const MAX_FILES = 600
/** Changed lines up to which a check stays one area. */
export const SINGLE_AREA_MAX_LINES = 600
/** Files up to which a check stays one area. */
export const SINGLE_AREA_MAX_FILES = 20

const CONTAINER_DIRS = new Set([
  'apps',
  'packages',
  'libs',
  'services',
  'modules',
  'cmd',
  'internal',
  'pkg',
  'src',
  'plugins',
  'components',
  'deploy',
])

const statusOf = (code: string): DiffFile['status'] =>
  code.startsWith('A')
    ? 'added'
    : code.startsWith('D')
      ? 'deleted'
      : code.startsWith('R')
        ? 'renamed'
        : code.startsWith('C')
          ? 'added'
          : 'modified'

/**
 * Changed files from `git diff --name-status -z` and `git diff --numstat -z` of the same range
 * (both with the same rename detection). Files numstat does not list count as zero lines;
 * numstat's `-` counts mark binary files.
 */
export function parseChangedFiles(nameStatus: string, numstat: string): ChangedFile[] {
  const counts = new Map<string, { added: number; deleted: number; binary: boolean }>()
  const stat = numstat.split('\0')
  for (let i = 0; i < stat.length; i++) {
    const entry = stat[i]
    if (!entry) continue
    const [added = '', deleted = '', path = ''] = entry.split('\t')
    const binary = added === '-' && deleted === '-'
    const value = { added: Number(added) || 0, deleted: Number(deleted) || 0, binary }
    if (path) counts.set(path, value)
    else {
      const next = stat[i + 2]
      if (next) counts.set(next, value)
      i += 2
    }
  }
  const files: ChangedFile[] = []
  const parts = nameStatus.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]?.trim()
    if (!code) continue
    const status = statusOf(code)
    const twoPaths = code.startsWith('R') || code.startsWith('C')
    const oldPath = parts[i + 1] ?? ''
    const newPath = twoPaths ? (parts[i + 2] ?? '') : oldPath
    i += twoPaths ? 2 : 1
    if (!newPath) continue
    const count = counts.get(newPath) ?? { added: 0, deleted: 0, binary: false }
    files.push({
      path: newPath,
      oldPath: code.startsWith('C') ? newPath : oldPath,
      status,
      ...count,
    })
  }
  return files
}

const unquote = (path: string) =>
  path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1).replace(/\\(.)/g, '$1') : path

/**
 * Files of a unified `git diff` (one `diff --git` section per file), with the diff text from the
 * first hunk on. Pure renames have an empty diff; `Binary files … differ` marks binary files.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  for (const section of text.split(/^diff --git /m).slice(1)) {
    const lines = section.split('\n')
    let oldPath = ''
    let newPath = ''
    let status: DiffFile['status'] = 'modified'
    let binary = false
    let hunkStart = -1
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.startsWith('@@')) {
        hunkStart = i
        break
      }
      if (line.startsWith('new file mode')) status = 'added'
      else if (line.startsWith('deleted file mode')) status = 'deleted'
      else if (line.startsWith('rename from ')) {
        status = 'renamed'
        oldPath = unquote(line.slice('rename from '.length))
      } else if (line.startsWith('rename to ')) newPath = unquote(line.slice('rename to '.length))
      else if (line.startsWith('--- ') && line !== '--- /dev/null')
        oldPath = unquote(line.slice(4)).replace(/^a\//, '')
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null')
        newPath = unquote(line.slice(4)).replace(/^b\//, '')
      else if (line.startsWith('Binary files ')) binary = true
    }
    if (!oldPath || !newPath) {
      const header = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(lines[0] ?? '')
      oldPath ||= header?.[1] ?? newPath
      newPath ||= header?.[2] ?? oldPath
    }
    if (!oldPath && !newPath) continue
    const diff = hunkStart < 0 ? '' : lines.slice(hunkStart).join('\n').replace(/\n+$/, '\n')
    files.push({ oldPath, newPath, status, diff, ...(binary && { binary: true }) })
  }
  return files
}

/** Changed lines of a file as weight; every file weighs at least one. */
export const weightOf = (file: ChangedFile): number => Math.max(1, file.added + file.deleted)

/** Files a check reads and the counts of those it leaves out, with why. */
export interface SelectedFiles {
  files: ChangedFile[]
  skipped: { files: number; reason: string }[]
  capped: boolean
}

const isSource = (path: string) =>
  !/(^|\/)(test|tests|__tests__|spec|docs?)\/|[._-](test|spec)\.\w+$|\.(md|mdx|rst|txt)$/i.test(
    path,
  )

/**
 * The changed files worth reading: binary files and lockfiles, generated, vendored or minified
 * files (`isRangeNoise` of `@holtkeeper/release`) are skipped. When more than `maxFiles` (default
 * `MAX_FILES`) remain, source files are kept before tests and docs and smaller changes before
 * larger ones, the rest is skipped and `capped` is set.
 */
export function selectFiles(
  changed: readonly ChangedFile[],
  maxFiles: number = MAX_FILES,
): SelectedFiles {
  let binary = 0
  let noise = 0
  const kept: ChangedFile[] = []
  for (const file of changed) {
    if (file.binary) binary++
    else if (isRangeNoise(file.path)) noise++
    else kept.push(file)
  }
  const skipped: SelectedFiles['skipped'] = []
  if (noise) skipped.push({ files: noise, reason: 'lockfiles, generated or vendored files' })
  if (binary) skipped.push({ files: binary, reason: 'binary files' })
  if (kept.length <= maxFiles) return { files: kept, skipped, capped: false }
  const order = new Map(kept.map((file, index) => [file.path, index]))
  const chosen = new Set(
    kept
      .toSorted(
        (a, b) =>
          Number(isSource(b.path)) - Number(isSource(a.path)) ||
          weightOf(a) - weightOf(b) ||
          a.path.localeCompare(b.path),
      )
      .slice(0, maxFiles)
      .map((file) => file.path),
  )
  skipped.push({ files: kept.length - maxFiles, reason: `past the limit of ${maxFiles} files` })
  return {
    files: kept
      .filter((file) => chosen.has(file.path))
      .toSorted((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)),
    skipped,
    capped: true,
  }
}

/**
 * The directory key a file is grouped by: its top-level directory, or the first two levels under
 * a usual container directory (`apps`, `packages`, `services`, `cmd`, `internal`, ...);
 * `(root)` for files at the top level.
 */
export function areaKeyOf(path: string): string {
  const segments = path.split('/')
  if (segments.length === 1) return '(root)'
  const [first = '', second] = segments
  return CONTAINER_DIRS.has(first) && segments.length > 2 && second ? `${first}/${second}` : first
}

const nameOf = (keys: readonly string[]) =>
  keys.length <= 3 ? keys.join(', ') : `${keys.slice(0, 3).join(', ')} and ${keys.length - 3} more`

/** Changed lines above which an area is split further while fewer than `maxAreas` exist. */
export const AREA_SPLIT_LINES = 1500

interface Group {
  key: string
  files: ChangedFile[]
}

const weightOfAll = (list: readonly ChangedFile[]) =>
  list.reduce((sum, file) => sum + weightOf(file), 0)

function splitGroup(group: Group): Group[] {
  if (group.key !== '(root)' && !group.key.includes(' (part ')) {
    const depth = group.key.split('/').length
    const parts = new Map<string, ChangedFile[]>()
    for (const file of group.files) {
      const segments = file.path.split('/')
      const key = segments.length > depth + 1 ? segments.slice(0, depth + 1).join('/') : group.key
      parts.set(key, [...(parts.get(key) ?? []), file])
    }
    if (parts.size > 1) return [...parts].map(([key, files]) => ({ key, files }))
  }
  const half = weightOfAll(group.files) / 2
  let index = 0
  for (let sum = 0; index < group.files.length - 1; index++) {
    const file = group.files[index]
    if (!file) break
    sum += weightOf(file)
    if (sum >= half) break
  }
  const cut = Math.min(group.files.length - 1, index + 1)
  return [
    { key: `${group.key} (part 1)`, files: group.files.slice(0, cut) },
    { key: `${group.key} (part 2)`, files: group.files.slice(cut) },
  ]
}

/**
 * Splits the files into at most `maxAreas` (default `MAX_AREAS`) areas: one when the change is
 * within `SINGLE_AREA_MAX_LINES` and `SINGLE_AREA_MAX_FILES`; otherwise files of one directory key
 * (`areaKeyOf`) start together. While fewer than `maxAreas` groups exist, the heaviest group over
 * `AREA_SPLIT_LINES` changed lines with more than one file is split by the next directory level,
 * or into two contiguous halves when its files share one directory. Then the heaviest groups seed
 * the areas and the rest join the lightest area. Areas are ordered by weight, heaviest first;
 * files keep their order.
 */
export function groupAreas(
  files: readonly ChangedFile[],
  maxAreas: number = MAX_AREAS,
): UpgradeArea[] {
  if (!files.length) return []
  const total = weightOfAll(files)
  if (total <= SINGLE_AREA_MAX_LINES && files.length <= SINGLE_AREA_MAX_FILES) {
    const keys = [...new Set(files.map((file) => areaKeyOf(file.path)))]
    return [{ keys, name: nameOf(keys), files: [...files] }]
  }
  const initial = new Map<string, ChangedFile[]>()
  for (const file of files) {
    const key = areaKeyOf(file.path)
    initial.set(key, [...(initial.get(key) ?? []), file])
  }
  let groups: Group[] = [...initial].map(([key, list]) => ({ key, files: list }))
  while (groups.length < maxAreas) {
    const heaviest = groups
      .filter((group) => group.files.length > 1 && weightOfAll(group.files) > AREA_SPLIT_LINES)
      .toSorted((a, b) => weightOfAll(b.files) - weightOfAll(a.files))[0]
    if (!heaviest) break
    groups = groups.flatMap((group) => (group === heaviest ? splitGroup(group) : [group]))
  }
  const sorted = groups.toSorted(
    (a, b) => weightOfAll(b.files) - weightOfAll(a.files) || a.key.localeCompare(b.key),
  )
  const areas = sorted
    .slice(0, maxAreas)
    .map((group) => ({ keys: [group.key], files: [...group.files] }))
  for (const group of sorted.slice(maxAreas)) {
    const lightest = areas.toSorted((a, b) => weightOfAll(a.files) - weightOfAll(b.files))[0]
    if (!lightest) break
    lightest.keys.push(group.key)
    lightest.files.push(...group.files)
  }
  const order = new Map(files.map((file, index) => [file.path, index]))
  return areas
    .toSorted((a, b) => weightOfAll(b.files) - weightOfAll(a.files))
    .map((area) => ({
      keys: area.keys,
      name: nameOf(area.keys),
      files: area.files.toSorted((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)),
    }))
}
