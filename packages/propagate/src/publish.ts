// oxlint-disable no-await-in-loop -- steps touch the same checkout or forge branch and run in order
import { join } from 'node:path'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'
import type { FileChange, GitForge } from '@holtkeeper/forge'

import { trimText } from './notes.ts'
import type { AgentReport, Bump, CheckResult, PackageTarget, ReleaseNotes } from './types.ts'

/** A file that differs from `HEAD` in a checkout. */
export interface ChangedFile {
  path: string
  /** `create` for untracked or added files. */
  action: FileChange['action']
}

const ignored = (path: string) => /(^|\/)node_modules\//.test(path)

/** Parses `git status --porcelain -z` output; renames yield a delete of the old path and a create of the new one. */
export function parseStatus(output: string): ChangedFile[] {
  const entries = output.split('\0').filter(Boolean)
  const files: ChangedFile[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (code[0] === 'R' || code[0] === 'C') {
      const original = entries[++i]
      if (code[0] === 'R' && original && !ignored(original))
        files.push({ path: original, action: 'delete' })
      if (!ignored(path)) files.push({ path, action: 'create' })
      continue
    }
    if (ignored(path)) continue
    const action = code.includes('D')
      ? 'delete'
      : code === '??' || code[0] === 'A'
        ? 'create'
        : 'update'
    files.push({ path, action })
  }
  return files
}

/** Files changed in the git checkout at `dir`, untracked ones included, `node_modules` excluded. */
export async function changedFiles(dir: string, runner: CommandRunner): Promise<ChangedFile[]> {
  const { stdout } = await runChecked(
    runner,
    ['git', 'status', '--porcelain', '-z', '--untracked-files=all'],
    {
      cwd: dir,
    },
  )
  return parseStatus(stdout)
}

/** Content hashes of the changed files, to tell which files a step touched. */
export async function snapshot(dir: string, runner: CommandRunner): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const file of await changedFiles(dir, runner)) {
    const handle = Bun.file(join(dir, file.path))
    result.set(
      file.path,
      (await handle.exists()) ? String(Bun.hash(await handle.arrayBuffer())) : 'deleted',
    )
  }
  return result
}

/** Paths whose state differs between two snapshots. */
export function touchedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((path) => before.get(path) !== after.get(path)).toSorted()
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '')

/** `<prefix>/<package-slug>-<version>`, joined for several packages and capped at 100 characters. */
export function branchName(prefix: string, targets: PackageTarget[]): string {
  const name = targets.map((target) => `${slug(target.name)}-${target.version}`).join('-')
  return `${prefix.replace(/\/+$/, '')}/${name}`.slice(0, 100).replace(/[-.]+$/, '')
}

/** One-line merge request title in Conventional Commits form. */
export function mergeRequestTitle(targets: PackageTarget[]): string {
  const list = targets.map((target) => `${target.name} to ${target.version}`)
  return `chore(deps): update ${list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', ')}`
}

const escapeCell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/** Input of `describeMergeRequest`; nothing in it is specific to package updates. */
export interface DescriptionInput {
  /** Leading sections, e.g. what was updated or ported. */
  sections?: { title: string; body: string }[]
  checks: CheckResult[]
  /** The fixer's last report, its attempts and the files it changed. */
  fix?: { report: AgentReport; attempts: number; files: string[] }
  /** Collapsed sections at the end, e.g. release notes or the source diff. */
  details?: { summary: string; body: string }[]
}

/**
 * Markdown merge request description: the given sections, a check results table, the tail of
 * each failing check's output, what the fixer changed and its remaining problems, then details.
 * When checks fail without a fix report it adds a "Needs attention" section.
 */
export function describeMergeRequest(input: DescriptionInput): string {
  const parts: string[] = []
  for (const section of input.sections ?? []) parts.push(`## ${section.title}`, section.body)
  if (input.checks.length) {
    parts.push(
      '## Checks',
      ['| Check | Result | Exit | Duration |', '| --- | --- | --- | --- |']
        .concat(
          input.checks.map(
            (check) =>
              `| ${check.name} \`${escapeCell(check.command)}\` | ${check.ok ? 'passed' : '**failed**'} | ${check.exitCode} | ${seconds(check.durationMs)} |`,
          ),
        )
        .join('\n'),
    )
  }
  const failing = input.checks.filter((check) => !check.ok)
  for (const check of failing)
    parts.push(
      `<details><summary>${check.name} output</summary>\n\n\`\`\`\n${trimText(check.output.split('\n').slice(-60).join('\n'), 4000)}\n\`\`\`\n\n</details>`,
    )
  if (input.fix) {
    const { report, attempts, files } = input.fix
    parts.push(
      `## Changes by the agent (${attempts} attempt${attempts === 1 ? '' : 's'})`,
      report.summary,
      ...(report.changes.length ? [report.changes.map((change) => `- ${change}`).join('\n')] : []),
      ...(files.length ? [`Files: ${files.map((file) => `\`${file}\``).join(', ')}`] : []),
    )
    if (report.remainingProblems.length)
      parts.push(
        '## Remaining problems',
        report.remainingProblems.map((problem) => `- ${problem}`).join('\n'),
      )
  } else if (failing.length)
    parts.push('## Needs attention', 'Checks fail and no automatic fix was attempted.')
  for (const detail of input.details ?? [])
    parts.push(
      `<details><summary>${detail.summary}</summary>\n\n${trimText(detail.body, 3000)}\n\n</details>`,
    )
  return parts.join('\n\n')
}

/** Input of `mergeRequestBody`. */
export interface MergeRequestBodyInput {
  bumps: Bump[]
  checks: CheckResult[]
  attempts: number
  agent?: AgentReport
  fixedFiles: string[]
  notes: ReleaseNotes[]
}

/** Description of a bump merge request: bumped packages, checks, agent changes, release notes. */
export function mergeRequestBody(input: MergeRequestBodyInput): string {
  return describeMergeRequest({
    sections: [
      {
        title: 'Updated packages',
        body: ['| Package | From | To | Manifest |', '| --- | --- | --- | --- |']
          .concat(
            input.bumps.map(
              (bump) =>
                `| \`${bump.package}\` | \`${bump.from}\` | \`${bump.to}\` | \`${bump.manifest}\` |`,
            ),
          )
          .join('\n'),
      },
    ],
    checks: input.checks,
    ...(input.agent
      ? { fix: { report: input.agent, attempts: input.attempts, files: input.fixedFiles } }
      : {}),
    details: input.notes.map((note) => ({
      summary: `Release notes: ${note.package} ${note.from ?? ''} → ${note.to}`,
      body: note.text,
    })),
  })
}

/**
 * Commits and pushes from a local checkout; `GitCheckout` of `@holtkeeper/workspace` satisfies it.
 */
export interface GitPublisher {
  /** Commits `paths` (deletions included); `undefined` when nothing changed. */
  commit(input: { message: string; paths?: string[] }): Promise<{ sha: string } | undefined>
  /** Points `branch` at the new commit; `pushed: false` when it already held the same tree. */
  push(input: { branch: string }): Promise<{ pushed: boolean; sha: string }>
}

/** Input of `publishChanges`. */
export interface PublishInput {
  forge: GitForge
  repo: string
  dir: string
  /** Changed files to publish, as `changedFiles` reports them. */
  files: ChangedFile[]
  branch: string
  title: string
  description: string
  labels: string[]
  /** Default false. */
  draft?: boolean
  /** Checks still fail: opens a draft and adds `attentionLabel`. */
  failed?: boolean
  /** Default `needs-attention`. */
  attentionLabel?: string
  /** Default: the repository's default branch. */
  targetBranch?: string
  /**
   * `api` (default) commits through `forge.commit`; such commits cannot carry our signature.
   * `git` commits in the checkout through `git` (signed when it was set up with signing) and
   * pushes the branch, replacing what an earlier run pushed there.
   */
  mode?: 'api' | 'git'
  /** Required for `mode: 'git'`. */
  git?: GitPublisher
}

/** Commits `files` through the forge API; `false` when nothing would change and no merge request exists. */
async function commitThroughApi(
  input: PublishInput,
  target: string,
  existing: boolean,
): Promise<boolean> {
  const { forge, repo, branch } = input
  const changes: FileChange[] = []
  for (const file of input.files) {
    const handle = Bun.file(join(input.dir, file.path))
    const content =
      file.action === 'delete' || !(await handle.exists()) ? undefined : await handle.text()
    if (!existing) {
      changes.push(
        content === undefined
          ? { action: 'delete', path: file.path }
          : { action: file.action === 'delete' ? 'update' : file.action, path: file.path, content },
      )
      continue
    }
    const onBranch = await forge.readFile(repo, file.path, branch)
    if (content === undefined) {
      if (onBranch !== undefined) changes.push({ action: 'delete', path: file.path })
    } else if (onBranch !== content)
      changes.push({
        action: onBranch === undefined ? 'create' : 'update',
        path: file.path,
        content,
      })
  }
  if (changes.length === 0 && !existing) return false
  if (changes.length)
    await forge.commit(repo, {
      branch,
      ...(existing ? {} : { startBranch: target }),
      message: input.title,
      changes,
    })
  return true
}

/** Commits `files` in the checkout and pushes the branch; `false` when there is nothing to propose. */
async function commitThroughGit(input: PublishInput, existing: boolean): Promise<boolean> {
  if (!input.git) throw new Error('publish mode "git" needs a git publisher (a writable checkout)')
  if (input.files.length === 0 && !existing) return false
  const commit = input.files.length
    ? await input.git.commit({ message: input.title, paths: input.files.map((file) => file.path) })
    : undefined
  if (!commit && !existing) return false
  if (commit) await input.git.push({ branch: input.branch })
  return true
}

/**
 * Commits `files` from the checkout to `branch` and opens a merge request, or updates the open one
 * for that branch; `undefined` when nothing would change and no merge request exists. `failed`
 * makes it a draft labeled `attentionLabel`.
 *
 * In `api` mode (default) the commit goes through `forge.commit` on top of the existing branch,
 * with actions chosen from the branch's contents and identical files left out. In `git` mode the
 * checkout commits and pushes (`input.git`), so commits can be signed with our key; API commits
 * never carry it (GitLab may sign them with its own key, depending on the instance).
 */
export async function publishChanges(
  input: PublishInput,
): Promise<{ id: number; url: string; draft: boolean } | undefined> {
  const { forge, repo, branch } = input
  const target = input.targetBranch ?? (await forge.getRepository(repo)).defaultBranch
  const existing = await forge.findMergeRequest(repo, { sourceBranch: branch, state: 'open' })
  const proceed =
    (input.mode ?? 'api') === 'git'
      ? await commitThroughGit(input, existing !== undefined)
      : await commitThroughApi(input, target, existing !== undefined)
  if (!proceed) return undefined
  const fields = {
    title: input.title,
    description: input.description,
    labels: input.failed
      ? [...new Set([...input.labels, input.attentionLabel ?? 'needs-attention'])]
      : input.labels,
    draft: (input.draft ?? false) || (input.failed ?? false),
  }
  const mergeRequest = existing
    ? await forge.updateMergeRequest(repo, existing.id, fields)
    : await forge.createMergeRequest(repo, {
        ...fields,
        sourceBranch: branch,
        targetBranch: target,
      })
  return { id: mergeRequest.id, url: mergeRequest.webUrl, draft: mergeRequest.draft }
}
