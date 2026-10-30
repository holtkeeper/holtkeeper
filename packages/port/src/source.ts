// oxlint-disable no-await-in-loop -- git and forge reads for one source run in order
import { type CommandRunner, runChecked } from '@holtkeeper/exec'
import type { DiffFile, GitForge, RepoRef } from '@holtkeeper/forge'
import { trimText } from '@holtkeeper/propagate'

import { fileStat, parsePatch } from './patch.ts'
import type { SourceChange, SourceFile, SourceSpec, StoredSourceFile } from './types.ts'

/** A checkout as the runner provides it; `runner`, when present, runs commands inside it. */
export interface Checkout {
  dir: string
  sha: string
  ref: string
  runner?: CommandRunner
  cleanup(): Promise<void>
}

/** Checks out a repository; mirrors `AnalyzerContext.checkout`. */
export type CheckoutFn = (
  repo: RepoRef,
  options?: { ref?: string; writable?: boolean },
) => Promise<Checkout>

/** Splits `forge:path`; a bare path belongs to `defaultForge`. */
export function parseRepo(spec: string, defaultForge: string): RepoRef {
  const match = /^([\w.-]+):(.+)$/.exec(spec)
  return match ? { forge: match[1]!, path: match[2]! } : { forge: defaultForge, path: spec }
}

/**
 * Parses the command form of a source: `forge:path!12` (merge request), `forge:path@sha1,sha2`
 * (commits) or `forge:path@from..to` (range).
 */
export function parseSourceSpec(text: string): SourceSpec {
  const mr = /^(.+)!(\d+)$/.exec(text)
  if (mr) return { repo: mr[1]!, mergeRequest: Number(mr[2]) }
  const at = /^(.+)@([^@]+)$/.exec(text)
  if (!at)
    throw new Error(
      `cannot read source "${text}": use repo!<mr>, repo@<sha>[,<sha>] or repo@<from>..<to>`,
    )
  const range = /^(.+?)\.\.\.?(.+)$/.exec(at[2]!)
  if (range) return { repo: at[1]!, range: { from: range[1]!, to: range[2]! } }
  return {
    repo: at[1]!,
    commits: at[2]!
      .split(',')
      .map((sha) => sha.trim())
      .filter(Boolean),
  }
}

/** Issue references in text: `#12`, `GTW-435`, and `/issues/<n>` URLs, in first-seen order. */
export function issueReferences(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(
    /https?:\/\/\S+?\/(?:-\/)?issues\/\d+|(?<![\w/!-])#\d+\b|\b[A-Z][A-Z0-9]{1,9}-\d+\b/g,
  ))
    found.add(match[0])
  return [...found]
}

const lastSegment = (path: string) => path.split('/').at(-1) ?? path

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')

/** Branch-safe name of the source: `<repo>-mr-12`, `<repo>-<sha8>`, `<repo>-<from8>-<to8>`. */
export function sourceSlug(
  source: Pick<SourceChange, 'path' | 'kind' | 'mergeRequest' | 'commits' | 'range'>,
): string {
  const name = slugify(lastSegment(source.path))
  const short = (sha: string) => slugify(sha).slice(0, 8)
  if (source.kind === 'merge-request') return `${name}-mr-${source.mergeRequest}`
  if (source.kind === 'range' && source.range)
    return `${name}-${short(source.range.from)}-${short(source.range.to)}`
  return `${name}-${(source.commits ?? []).map(short).join('-')}`.slice(0, 80)
}

/**
 * Deterministic summary of what the change does: title, source, issues, description and every
 * file with its line counts and the code locations its hunks sit in.
 */
export function intentSummary(source: SourceChange): string {
  const label =
    source.kind === 'merge-request'
      ? `${source.repo}!${source.mergeRequest}`
      : source.kind === 'range'
        ? `${source.repo}@${source.range?.from}..${source.range?.to}`
        : `${source.repo}@${(source.commits ?? []).join(',')}`
  const lines = [
    `Title: ${source.title}`,
    `Source: ${label}${source.webUrl ? ` (${source.webUrl})` : ''}`,
  ]
  if (source.issues.length) lines.push(`Issues: ${source.issues.join(', ')}`)
  if (source.description.trim())
    lines.push('', 'Description:', trimText(source.description.trim(), 1500))
  lines.push('', 'Files:')
  const marks = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const
  for (const file of source.files) {
    const stat = fileStat(file)
    const headings = [
      ...new Set(
        file.diff
          .split('\n')
          .map((line) => /^@@[^@]*@@ ?(.+)$/.exec(line)?.[1]?.trim())
          .filter((heading): heading is string => Boolean(heading)),
      ),
    ].slice(0, 5)
    const path = file.status === 'renamed' ? `${file.oldPath} → ${file.newPath}` : file.newPath
    lines.push(
      `- ${marks[file.status]} ${path} (+${stat.additions} −${stat.deletions})${file.binary ? ' binary' : ''}${
        headings.length ? `: ${headings.map((heading) => `\`${heading}\``).join(', ')}` : ''
      }`,
    )
  }
  return lines.join('\n')
}

/** Source files as stored in analysis data: no pre-images, diffs trimmed. */
export function storedFiles(files: SourceFile[]): StoredSourceFile[] {
  return files.map((file) => ({
    oldPath: file.oldPath,
    newPath: file.newPath,
    status: file.status,
    ...(file.binary ? { binary: true } : {}),
    ...fileStat(file),
    diff: trimText(file.diff, 20_000),
  }))
}

/** Loads a source change; replaceable to read it from elsewhere. */
export interface SourceLoader {
  /** Rejects when the change cannot be read. */
  load(input: {
    spec: SourceSpec
    forge: GitForge
    forgeId: string
    checkout?: CheckoutFn
    runner: CommandRunner
    signal?: AbortSignal
  }): Promise<SourceChange>
}

const fromDiffFile = (file: DiffFile): SourceFile => ({
  oldPath: file.oldPath,
  newPath: file.newPath,
  status: file.status,
  diff: file.diff && !file.diff.endsWith('\n') ? `${file.diff}\n` : file.diff,
  ...(file.binary || file.collapsed ? { binary: true } : {}),
})

const maxPreimages = 100

const withIssues = (change: Omit<SourceChange, 'issues'>): SourceChange => ({
  ...change,
  issues: issueReferences(`${change.title}\n${change.description}`),
})

/** Validates that a spec names exactly one kind of change. */
export function sourceKind(spec: SourceSpec): SourceChange['kind'] {
  const given = [
    spec.mergeRequest !== undefined,
    (spec.commits?.length ?? 0) > 0,
    spec.range !== undefined,
  ].filter(Boolean).length
  if (given !== 1) throw new Error('source needs exactly one of mergeRequest, commits or range')
  return spec.mergeRequest !== undefined ? 'merge-request' : spec.range ? 'range' : 'commits'
}

async function gitShow(
  runner: CommandRunner,
  dir: string,
  object: string,
): Promise<string | undefined> {
  const result = await runner.run(['git', 'show', object], { cwd: dir })
  return result.exitCode === 0 ? result.stdout : undefined
}

async function fromCheckout(
  input: Parameters<SourceLoader['load']>[0],
  ref: RepoRef,
  kind: 'commits' | 'range',
) {
  const { spec } = input
  const tip = kind === 'range' ? spec.range!.to : spec.commits!.at(-1)!
  const checkout = await input.checkout!(ref, { ref: tip })
  const runner = checkout.runner ?? input.runner
  const git = (...args: string[]) =>
    runChecked(runner, ['git', '-c', 'core.quotepath=off', ...args], {
      cwd: checkout.dir,
      ...(input.signal ? { signal: input.signal } : {}),
    }).then((result) => result.stdout)
  try {
    const files: SourceFile[] = []
    const subjects: string[] = []
    const bodies: string[] = []
    const pieces =
      kind === 'range'
        ? [
            {
              base: spec.range!.from,
              patch: await git('diff', '--binary', '-M', spec.range!.from, spec.range!.to),
            },
          ]
        : await Promise.all(
            spec.commits!.map(async (sha) => ({
              base: `${sha}^`,
              patch: await git('show', '--format=', '--binary', '-M', sha),
            })),
          )
    const log =
      kind === 'range'
        ? await git(
            'log',
            '--reverse',
            '--format=%s%x1f%b%x1e',
            `${spec.range!.from}..${spec.range!.to}`,
          )
        : (
            await Promise.all(
              spec.commits!.map((sha) => git('log', '-1', '--format=%s%x1f%b%x1e', sha)),
            )
          ).join('')
    for (const entry of log.split('\x1e')) {
      const [subject, body] = entry.trim().split('\x1f')
      if (subject?.trim()) subjects.push(subject.trim())
      if (body?.trim()) bodies.push(body.trim())
    }
    for (const piece of pieces)
      for (const file of parsePatch(piece.patch)) {
        if (file.status !== 'added' && !file.binary && files.length < maxPreimages) {
          const preimage = await gitShow(runner, checkout.dir, `${piece.base}:${file.oldPath}`)
          if (preimage !== undefined) file.preimage = preimage
        }
        files.push(file)
      }
    return { files, subjects, description: bodies.join('\n\n') }
  } finally {
    await checkout.cleanup().catch(() => undefined)
  }
}

/**
 * Reads merge requests through the forge (`getMergeRequest`, `getMergeRequestDiff`, pre-images
 * with `readFile` at the base commit). Commits and ranges come from a read-only checkout of the
 * source when `checkout` is given (full patches with pre-images), else from `compareCommits`.
 */
export const defaultSourceLoader: SourceLoader = {
  async load(input) {
    const { spec, forge } = input
    const kind = sourceKind(spec)
    const ref = parseRepo(spec.repo, input.forgeId)
    const repoLabel = `${ref.forge}:${ref.path}`
    const base = {
      repo: repoLabel,
      path: ref.path,
      kind,
      ...(spec.mergeRequest !== undefined ? { mergeRequest: spec.mergeRequest } : {}),
      ...(spec.commits?.length ? { commits: spec.commits } : {}),
      ...(spec.range ? { range: spec.range } : {}),
    }
    if (kind === 'merge-request') {
      if (!forge.getMergeRequest || !forge.getMergeRequestDiff)
        throw new Error(`forge ${forge.kind} cannot read merge requests`)
      const id = spec.mergeRequest!
      const [mr, diff] = await Promise.all([
        forge.getMergeRequest(ref.path, id),
        forge.getMergeRequestDiff(ref.path, id),
      ])
      const files = diff.files.map(fromDiffFile)
      for (const file of files.slice(0, maxPreimages)) {
        if (file.status === 'added' || file.binary) continue
        const preimage = await forge
          .readFile(ref.path, file.oldPath, diff.refs.baseSha)
          .catch(() => undefined)
        if (preimage !== undefined) file.preimage = preimage
      }
      return withIssues({
        ...base,
        title: mr.title,
        description: mr.description,
        webUrl: mr.webUrl,
        files,
      })
    }

    const repository = await forge.getRepository(ref.path).catch(() => undefined)
    const webUrl = repository?.webUrl
    if (input.checkout) {
      const loaded = await fromCheckout(input, ref, kind)
      const title =
        loaded.subjects.length > 1
          ? `${loaded.subjects[0]} (+${loaded.subjects.length - 1} more)`
          : (loaded.subjects[0] ?? `${kind} of ${ref.path}`)
      return withIssues({
        ...base,
        title,
        description: loaded.description,
        ...(webUrl ? { webUrl } : {}),
        files: loaded.files,
      })
    }
    if (!forge.compareCommits)
      throw new Error(`forge ${forge.kind} cannot compare commits and no checkout is available`)
    const pairs =
      kind === 'range'
        ? [[spec.range!.from, spec.range!.to] as const]
        : spec.commits!.map((sha) => [`${sha}^`, sha] as const)
    const files: SourceFile[] = []
    for (const [from, to] of pairs)
      files.push(...(await forge.compareCommits(ref.path, from, to)).map(fromDiffFile))
    const title =
      kind === 'range'
        ? `Changes ${spec.range!.from}..${spec.range!.to} of ${ref.path}`
        : `Commits ${spec.commits!.map((sha) => sha.slice(0, 8)).join(', ')} of ${ref.path}`
    return withIssues({ ...base, title, description: '', ...(webUrl ? { webUrl } : {}), files })
  },
}
