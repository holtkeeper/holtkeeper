import { type CommandRunner, localRunner, runChecked } from '@holtkeeper/exec'

import type {
  ChangedFile,
  CommitInfo,
  CommitRange,
  DiffStat,
  FileStatus,
  HistorySource,
  ReleaseRef,
} from './types.ts'
import { compareVersions, isVersion } from './version.ts'

const RS = '\u001e'
const US = '\u001f'

export interface GitHistoryOptions {
  /** Defaults to `localRunner`. */
  runner?: CommandRunner
}

/** Parses `git --shortstat` output; zeros when the text has no stat line. */
export function parseShortStat(text: string): DiffStat {
  const count = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0)
  return {
    files: count(/(\d+) files? changed/u),
    insertions: count(/(\d+) insertions?\(\+\)/u),
    deletions: count(/(\d+) deletions?\(-\)/u),
  }
}

const byDate = (a: ReleaseRef, b: ReleaseRef) =>
  Date.parse(b.date) - Date.parse(a.date) || b.name.localeCompare(a.name)

/** Newest first: by semantic version when every name is one, by date otherwise. */
export function sortRefs(refs: ReleaseRef[]): ReleaseRef[] {
  const versions = refs.length > 0 && refs.every((ref) => isVersion(ref.name))
  return refs.toSorted(
    versions ? (a, b) => compareVersions(b.name, a.name) || byDate(a, b) : byDate,
  )
}

const logFormat = `${RS}%H${US}%P${US}%an${US}%ae${US}%aI${US}%s${US}%b${US}`

/** Parses `git log --format=<logFormat> --shortstat` output. */
export function parseLog(stdout: string): CommitInfo[] {
  return stdout
    .split(RS)
    .filter((record) => record.trim())
    .map((record) => {
      const [
        sha = '',
        parents = '',
        name = '',
        email = '',
        date = '',
        subject = '',
        body = '',
        stat = '',
      ] = record.split(US)
      return {
        sha: sha.trim(),
        parents: parents.split(' ').filter(Boolean),
        author: { name, email },
        date,
        subject,
        body: body.trim(),
        stats: parseShortStat(stat),
      }
    })
}

/** Parses `git for-each-ref refs/tags` output in the format `gitHistory` requests. */
export function parseTags(stdout: string): ReleaseRef[] {
  const refs: ReleaseRef[] = []
  for (const record of stdout.split(RS)) {
    if (!record.trim()) continue
    const [name = '', type = '', object = '', peeled = '', date = '', contents = ''] = record
      .replace(/^\n/u, '')
      .split(US)
    const annotated = type === 'tag'
    const sha = annotated ? peeled : type === 'commit' ? object : ''
    if (!name || !sha) continue
    const message = annotated ? contents.replace(/-----BEGIN [\s\S]*$/u, '').trim() : ''
    refs.push({ name, sha, date, ...(message ? { message } : {}) })
  }
  return refs
}

const statuses: Record<string, FileStatus> = {
  A: 'added',
  C: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'modified',
  R: 'renamed',
}

/**
 * Joins `git diff -z --numstat -M` and `git diff -z --name-status -M` output of the same range.
 * Binary files have zero line counts and `binary: true`.
 */
export function parseChangedFiles(numstat: string, nameStatus: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  const fields = numstat.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field) continue
    const [added = '', removed = '', inline = ''] = field.split('\t')
    let path = inline
    let previousPath: string | undefined
    if (!inline) {
      previousPath = fields[++i]
      path = fields[++i] ?? ''
    }
    if (!path) continue
    const binary = added === '-' && removed === '-'
    files.set(path, {
      path,
      insertions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(removed) || 0,
      ...(previousPath ? { previousPath } : {}),
      ...(binary ? { binary } : {}),
    })
  }
  const entries = nameStatus.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i]
    if (!code) continue
    const status = statuses[code[0] ?? '']
    const paired = code[0] === 'R' || code[0] === 'C'
    const previousPath = paired ? entries[++i] : undefined
    const path = entries[++i] ?? ''
    const file = files.get(path) ?? { path, insertions: 0, deletions: 0 }
    if (status) file.status = status
    if (previousPath) file.previousPath = previousPath
    files.set(path, file)
  }
  return [...files.values()]
}

const range = ({ from, to }: CommitRange) => (from ? [`${from}..${to}`] : [to])

/** `HistorySource` backed by the git CLI in a local clone. */
export function gitHistory({ runner = localRunner }: GitHistoryOptions = {}): HistorySource {
  const git = async (dir: string, args: string[]) =>
    (
      await runChecked(
        runner,
        ['git', '-c', 'core.quotepath=off', '-c', 'log.showSignature=false', ...args],
        { cwd: dir, env: { GIT_PAGER: 'cat', LC_ALL: 'C' } },
      )
    ).stdout

  const emptyTree = async (dir: string) =>
    (await git(dir, ['hash-object', '-t', 'tree', '--stdin'])).trim()

  const source: HistorySource = {
    async listRefs(dir) {
      const stdout = await git(dir, [
        'for-each-ref',
        `--format=%(refname:lstrip=2)%1f%(objecttype)%1f%(objectname)%1f%(*objectname)%1f%(creatordate:iso-strict)%1f%(contents)%1e`,
        'refs/tags',
      ])
      return sortRefs(parseTags(stdout))
    },

    async resolve(dir, ref) {
      const tag = (await source.listRefs(dir)).find((candidate) => candidate.name === ref)
      if (tag) return tag
      const stdout = await git(dir, ['log', '-1', `--format=%H${US}%cI`, ref, '--'])
      const [sha = '', date = ''] = stdout.trim().split(US)
      return { name: ref, sha, date }
    },

    async commits(dir, commitRange) {
      const stdout = await git(dir, [
        'log',
        `--format=${logFormat}`,
        '--shortstat',
        '--no-color',
        ...range(commitRange),
        '--',
      ])
      return parseLog(stdout)
    },

    async diffStat(dir, { from, to }) {
      const base = from ?? (await emptyTree(dir))
      return parseShortStat(await git(dir, ['diff', '--shortstat', base, to, '--']))
    },

    async changedFiles(dir, { from, to }) {
      const base = from ?? (await emptyTree(dir))
      const [numstat, nameStatus] = await Promise.all([
        git(dir, ['diff', '-z', '--numstat', '-M', base, to, '--']),
        git(dir, ['diff', '-z', '--name-status', '-M', base, to, '--']),
      ])
      return parseChangedFiles(numstat, nameStatus)
    },
  }
  return source
}
