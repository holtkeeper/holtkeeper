import { lstat, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'

import {
  type CommitConventions,
  type Problem,
  checkCommitMessage,
} from '@holtkeeper/commit-conventions'
import type { FileChange, GitForge } from '@holtkeeper/forge'

import type { AgentReport, CheckResult } from './schema.ts'
import type { ChangedFile } from './workspace.ts'

/** A commit message and what the repository's conventions still object to. */
export interface CommitMessageChoice {
  message: string
  /** Errors only; history-based warnings are not kept. */
  problems: Problem[]
}

const errorsOf = (conventions: CommitConventions, message: string) =>
  checkCommitMessage(conventions.commit, message).filter((problem) => problem.severity === 'error')

const typeOf = (kind: string) => (kind === 'fix' ? 'fix' : kind === 'tests' ? 'test' : 'chore')

/**
 * The first candidate that the repository's commit conventions accept, else the first one with a
 * Conventional Commits type added when titles must be conventional, else the first candidate with
 * its problems. Without conventions the first candidate is taken as is.
 */
export function chooseCommitMessage(
  candidates: readonly string[],
  conventions: CommitConventions | undefined,
  kind: string,
): CommitMessageChoice {
  const messages = candidates.map((message) => message.trim()).filter(Boolean)
  const first = messages[0] ?? 'Holtkeeper task'
  if (!conventions) return { message: first, problems: [] }
  for (const message of messages)
    if (errorsOf(conventions, message).length === 0) return { message, problems: [] }
  if (conventions.commit.rules.conventional) {
    const subject = first.split('\n')[0]!
    const typed = `${typeOf(kind)}: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`
    if (errorsOf(conventions, typed).length === 0) return { message: typed, problems: [] }
  }
  return { message: first, problems: errorsOf(conventions, first) }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

/** Markdown description of a write task's merge request. */
export function describeChange(input: {
  title: string
  prompt?: string
  taskId: string
  path: 'patch' | 'agent' | 'patch+agent'
  checks: readonly CheckResult[]
  agent?: AgentReport
  /** What the agent wrote for the merge request description. */
  notes?: string
  problems?: readonly Problem[]
}): string {
  const parts = [`Opened by Holtkeeper task \`${input.taskId}\`: ${input.title}`]
  if (input.prompt?.trim())
    parts.push('## Task', input.prompt.trim().split('\n').slice(0, 30).join('\n'))
  parts.push(
    `Made by ${input.path === 'patch' ? 'applying the given patch' : input.path === 'agent' ? 'the agent' : 'applying the given patch, then the agent'}.`,
  )
  if (input.notes) parts.push(input.notes)
  if (input.agent) {
    parts.push('## Changes', input.agent.summary)
    if (input.agent.changes.length)
      parts.push(input.agent.changes.map((change) => `- ${change}`).join('\n'))
    if (input.agent.remainingProblems.length)
      parts.push(
        '## Remaining problems',
        input.agent.remainingProblems.map((problem) => `- ${problem}`).join('\n'),
      )
  }
  if (input.checks.length)
    parts.push(
      '## Checks',
      ['| Check | Result | Duration |', '| --- | --- | --- |']
        .concat(
          input.checks.map(
            (check) =>
              `| ${cell(check.name)} \`${cell(check.command)}\` | ${check.ok ? 'passed' : `**failed** (${check.exitCode})`} | ${seconds(check.durationMs)} |`,
          ),
        )
        .join('\n'),
    )
  for (const check of input.checks.filter((each) => !each.ok))
    parts.push(
      `<details><summary>${cell(check.name)} output</summary>\n\n\`\`\`\n${check.output}\n\`\`\`\n\n</details>`,
    )
  if (input.problems?.length)
    parts.push(
      '## Commit message',
      input.problems.map((problem) => `- ${problem.message}`).join('\n'),
    )
  return parts.join('\n\n')
}

/** Commits and pushes from the checkout over git; signed when the checkout signs. */
interface GitPublisher {
  commit(input: { message: string; paths?: string[] }): Promise<{ sha: string } | undefined>
  push(input: { branch: string }): Promise<{ pushed: boolean; sha: string }>
}

/** Input of `publishChange`. */
export interface PublishInput {
  forge: GitForge
  repo: string
  dir: string
  files: readonly ChangedFile[]
  branch: string
  targetBranch: string
  message: string
  title: string
  description: string
  draft: boolean
  /** Push over git through it (signed commits); without it the commit goes through `forge.commit`. */
  git?: GitPublisher
}

/** Refuses anything but a regular file inside `dir`: symlinks would publish what they point at. */
async function regularFile(dir: string, path: string): Promise<boolean> {
  const full = join(dir, path)
  const stats = await lstat(full).catch(() => undefined)
  if (!stats) return false
  const inside = relative(await realpath(dir), await realpath(full))
  if (!stats.isFile() || inside.startsWith('..') || inside === '')
    throw new Error(`refusing to publish ${path}: not a regular file in the checkout`)
  return true
}

async function apiChanges(dir: string, files: readonly ChangedFile[]): Promise<FileChange[]> {
  return Promise.all(
    files.map(async (file): Promise<FileChange> => {
      if (file.action === 'delete' || !(await regularFile(dir, file.path)))
        return { action: 'delete', path: file.path }
      const handle = Bun.file(join(dir, file.path))
      const bytes = new Uint8Array(await handle.arrayBuffer())
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      const binary = bytes.includes(0) || text.includes('\uFFFD')
      return {
        action: file.action === 'create' ? 'create' : 'update',
        path: file.path,
        content: binary ? Buffer.from(bytes).toString('base64') : text,
        ...(binary && { encoding: 'base64' as const }),
      }
    }),
  )
}

/** `changes` made against the target branch, turned into actions on `branch` as it is now. */
async function againstBranch(
  forge: GitForge,
  repo: string,
  branch: string,
  changes: readonly FileChange[],
): Promise<FileChange[]> {
  const actions = await Promise.all(
    changes.map(async (change): Promise<FileChange | undefined> => {
      const present = (await forge.readFile(repo, change.path, branch)) !== undefined
      if (change.action === 'delete') return present ? change : undefined
      return { ...change, action: present ? 'update' : 'create' }
    }),
  )
  return actions.filter((change): change is FileChange => change !== undefined)
}

/**
 * Commits `files` to `branch`, created from `targetBranch` (through `git` when given, else the
 * forge API), and opens a merge request for it, or updates the open one of that branch. Over the
 * API a branch without an open merge request (left by an earlier run) is deleted and made again
 * from `targetBranch`; with one, the commit's actions follow what the branch holds. Symlinks and
 * other non-regular files are refused. Returns
 * the merge request and the commit sha when the forge reports one.
 */
export async function publishChange(
  input: PublishInput,
): Promise<{ id: number; url: string; draft: boolean; sha?: string }> {
  const { forge, repo, branch } = input
  const existing = await forge.findMergeRequest(repo, { sourceBranch: branch, state: 'open' })
  let sha: string | undefined
  if (input.git) {
    const commit = await input.git.commit({
      message: input.message,
      paths: input.files.map((file) => file.path),
    })
    if (commit) sha = (await input.git.push({ branch })).sha
  } else {
    const changes = await apiChanges(input.dir, input.files)
    if (!existing) await forge.deleteBranch(repo, branch).catch(() => undefined)
    const commit = await forge.commit(repo, {
      branch,
      ...(existing ? {} : { startBranch: input.targetBranch }),
      message: input.message,
      changes: existing ? await againstBranch(forge, repo, branch, changes) : changes,
    })
    sha = commit.sha
  }
  const fields = { title: input.title, description: input.description, draft: input.draft }
  const mergeRequest = existing
    ? await forge.updateMergeRequest(repo, existing.id, fields)
    : await forge.createMergeRequest(repo, {
        ...fields,
        sourceBranch: branch,
        targetBranch: input.targetBranch,
      })
  return {
    id: mergeRequest.id,
    url: mergeRequest.webUrl,
    draft: mergeRequest.draft,
    ...(sha !== undefined && { sha }),
  }
}
