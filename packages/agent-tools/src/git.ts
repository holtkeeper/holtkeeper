import { posix } from 'node:path'

import type { ToolContext, Toolset } from '@holtkeeper/agent'
import type { CommandResult, CommandRunner } from '@holtkeeper/exec'
import { z } from 'zod'

import { type Budget, budgetOf, clip, limitLines } from './budget.ts'
import { RESULT_CAPS } from './registry.ts'
import { ToolError, defineTool } from './tool.ts'

/** Most commits `git.log` lists per call. */
const MAX_LOG = 50
/** Commits `git.log` lists when no `limit` is passed. */
const DEFAULT_LOG = 20
/** Most lines `git.blame` annotates per call. */
const MAX_BLAME_LINES = 200
/** Longest revision accepted. */
const MAX_REV_LENGTH = 200
const GIT_TIMEOUT_MS = 30_000
/** Characters a result may use, below the server's cap so our own truncation note survives. */
const MAX_CHARS = RESULT_CAPS.maxChars - 400

/**
 * A revision the git tools accept: a ref name or abbreviated sha (`HEAD`, `main`, `origin/x`,
 * `refs/tags/v1.2`, `7d6c0a1`) optionally followed by `~N`/`^N` steps. Never an option, a range or
 * a reflog expression.
 */
const REV = /^[A-Za-z0-9_][A-Za-z0-9_./+-]*(?:[~^]\d{0,4})*$/

const NOT_FOUND =
  /unknown revision|bad revision|bad object|invalid object name|not a valid object name|ambiguous argument|no such ref|needed a single revision/i

/** `rev` if it is a safe revision; a `ToolError` otherwise. */
function checkRev(rev: string): string {
  const value = rev.trim()
  if (
    !value ||
    value.length > MAX_REV_LENGTH ||
    !REV.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  )
    throw new ToolError(
      `invalid revision "${rev}": pass a commit sha (4-40 hex characters) or a ref name such as HEAD, HEAD~3, origin/main or refs/tags/v1.0`,
    )
  return value
}

/** `path` normalized and relative to the checkout; a `ToolError` when it is absolute or escapes it. */
function checkPath(path: string): string {
  const value = path.trim().replaceAll('\\', '/')
  if (!value || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value))
    throw new ToolError(`invalid path "${path}": pass a path relative to the repository root`)
  const normalized = posix.normalize(value).replace(/\/+$/, '')
  if (normalized === '..' || normalized.startsWith('../') || value.split('/').includes('..'))
    throw new ToolError(`${path} is outside the working directory`)
  return normalized === '' ? '.' : normalized
}

/**
 * The git command line: no pager, colors, external diff drivers or pathspec magic, paths printed
 * as they are.
 */
function gitCommand(args: readonly string[]): string[] {
  return [
    'git',
    '--no-pager',
    '--literal-pathspecs',
    '-c',
    'core.quotepath=off',
    '-c',
    'color.ui=false',
    ...args,
  ]
}

async function git(
  runner: CommandRunner,
  args: readonly string[],
  { dir, signal }: ToolContext,
): Promise<CommandResult> {
  if (signal.aborted) throw new ToolError('the task was stopped')
  return runner.run(gitCommand(args), { cwd: dir, signal, timeoutMs: GIT_TIMEOUT_MS })
}

/** The last lines of git's error output, for the agent. */
const gitMessage = (result: CommandResult) =>
  (result.stderr || result.stdout).trim().split('\n').slice(-3).join('\n') ||
  `git exited with ${result.exitCode}`

/**
 * Throws a `ToolError` for a failed git run: a revision missing from the checkout is named as
 * such, a shallow checkout is mentioned when git reports one.
 */
async function failure(
  runner: CommandRunner,
  result: CommandResult,
  revs: readonly string[],
  ctx: ToolContext,
): Promise<never> {
  const message = gitMessage(result)
  if (/not a git repository/i.test(message))
    throw new ToolError('the checkout is not a git repository; git history is not available')
  if (NOT_FOUND.test(message) && revs.length) {
    const missing = revs.find((rev) => message.includes(rev)) ?? revs.join(', ')
    const shallow = await git(runner, ['rev-parse', '--is-shallow-repository'], ctx).catch(
      () => undefined,
    )
    if (shallow?.exitCode === 0 && shallow.stdout.trim() === 'true')
      throw new ToolError(`commit ${missing} is not in this checkout; fetch may be shallow`)
    throw new ToolError(`unknown revision ${missing}`)
  }
  throw new ToolError(message)
}

async function gitOk(
  runner: CommandRunner,
  args: readonly string[],
  revs: readonly string[],
  ctx: ToolContext,
): Promise<string> {
  const result = await git(runner, args, ctx)
  if (result.exitCode !== 0) return failure(runner, result, revs, ctx)
  return result.stdout
}

const lines = (text: string) => {
  const out = text.replace(/\n+$/, '').split('\n')
  return out.length === 1 && out[0] === '' ? [] : out
}

const DIFF_FILE = /^diff --git a\/(.*) b\/(.*)$/

/**
 * `head` (commit header and `--stat`) and as much of `patch` as fits in the budget, then a note
 * naming the files whose patch was cut and how to read them.
 */
function capPatch(
  head: readonly string[],
  patch: readonly string[],
  budget: Pick<Budget, 'maxResultLines' | 'maxLineLength'>,
): string {
  const max = budget.maxResultLines
  const shownHead = limitLines(
    head.map((line) => clip(line, budget.maxLineLength)),
    Math.max(1, Math.floor(max / 2)),
    'stat lines',
  )
  const out = [...shownHead]
  let chars = out.reduce((sum, line) => sum + line.length + 1, 0)
  let index = 0
  for (; index < patch.length; index++) {
    const line = clip(patch[index] ?? '', budget.maxLineLength)
    const room = index === patch.length - 1 ? max : max - 1
    if (out.length + 1 > room || chars + line.length + 1 > MAX_CHARS) break
    out.push(line)
    chars += line.length + 1
  }
  if (index < patch.length) {
    const rest = patch.slice(index)
    const current = patch
      .slice(0, index)
      .findLast((line) => DIFF_FILE.test(line))
      ?.match(DIFF_FILE)?.[2]
    const cutFiles = [
      ...new Set([
        ...(current && !DIFF_FILE.test(rest[0] ?? '') ? [current] : []),
        ...rest.flatMap((line) => line.match(DIFF_FILE)?.[2] ?? []),
      ]),
    ]
    const named = cutFiles.slice(0, 5).join(', ')
    const more = cutFiles.length > 5 ? ` and ${cutFiles.length - 5} more` : ''
    out.push(
      `… ${rest.length} more patch lines cut (${named}${more}); pass path to read one file's patch, or read the file`,
    )
  }
  return out.join('\n')
}

const pathArgs = (path: string | undefined) => (path ? ['--', checkPath(path)] : ['--'])

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv']

/** What `gitTools` needs: a runner for git and optional output limits. */
export interface GitToolsOptions {
  /** Runs git in the task directory (the checkout). */
  runner: CommandRunner
  /** Output limits; `DEFAULT_BUDGET` where not given. */
  budget?: Partial<Budget>
}

/**
 * The `git` toolset: read-only history of the task checkout. `git.show` (a commit with its stat
 * and patch), `git.log` (one line per commit), `git.diff` (stat and patch between two revisions)
 * and `git.blame` (who last changed a line range). Every revision is validated (no options, no
 * ranges), paths are confined to the checkout and passed after `--`, results stay within the
 * budget and say what was cut. A revision missing from the checkout is a `ToolError` naming it.
 */
export function gitTools(options: GitToolsOptions): Toolset {
  const { runner } = options
  const budget = budgetOf(options.budget)
  const blameMax = Math.min(MAX_BLAME_LINES, budget.maxResultLines - 2)
  return {
    name: 'git',
    instructions:
      'Read the history of the checkout: use git.show when someone asks to check a commit, git.log and git.blame to learn why code looks the way it does, git.diff to see what changed since an earlier commit (e.g. the last reviewed one).',
    tools: [
      defineTool({
        name: 'git.show',
        description:
          'One commit of the checkout: sha, author, date, full message, --stat and the patch (optionally of one path), capped with a note on what was cut. Use it when someone asks to check a commit.',
        input: z.object({
          rev: z.string().min(1).describe('Commit sha (4-40 hex characters) or ref, e.g. HEAD~1'),
          path: z.string().optional().describe('Limit the patch to this file or directory'),
        }),
        subject: ({ rev }) => rev,
        async run({ rev, path }, ctx) {
          const commit = checkRev(rev)
          const paths = pathArgs(path)
          const header = await gitOk(
            runner,
            [
              'show',
              ...DIFF_FLAGS,
              '--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B',
              '--date=iso-strict',
              '--stat',
              '--diff-merges=first-parent',
              commit,
              ...paths,
            ],
            [commit],
            ctx,
          )
          const patch = await gitOk(
            runner,
            [
              'show',
              ...DIFF_FLAGS,
              '--format=',
              '--patch',
              '--diff-merges=first-parent',
              commit,
              ...paths,
            ],
            [commit],
            ctx,
          )
          const head = lines(header)
          const body = lines(patch)
          if (!body.length && path) head.push('', `no changes to ${checkPath(path)} in this commit`)
          return capPatch(head, body, budget)
        },
      }),
      defineTool({
        name: 'git.log',
        description: `Commits reachable from rev (default HEAD), newest first, optionally only those touching a path: one line each with short sha, date, author and subject. limit defaults to ${DEFAULT_LOG}, at most ${MAX_LOG}.`,
        input: z.object({
          path: z.string().optional().describe('Only commits touching this file or directory'),
          rev: z.string().optional().describe('Start from this commit or ref, default HEAD'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_LOG)
            .optional()
            .describe(`Most commits, default ${DEFAULT_LOG}`),
        }),
        defaultLimit: DEFAULT_LOG,
        subject: ({ path, rev }) => path ?? rev,
        async run({ path, rev = 'HEAD', limit = DEFAULT_LOG }, ctx) {
          const start = checkRev(rev)
          const count = Math.min(Math.max(1, limit), MAX_LOG)
          const out = await gitOk(
            runner,
            [
              'log',
              '--no-color',
              '--format=%h %ad %an: %s',
              '--date=short',
              `--max-count=${count + 1}`,
              start,
              ...pathArgs(path),
            ],
            [start],
            ctx,
          )
          const commits = lines(out)
          if (!commits.length) return path ? `no commits touch ${checkPath(path)}` : 'no commits'
          const shown = commits.slice(0, count).map((line) => clip(line, budget.maxLineLength))
          const kept = limitLines(shown, budget.maxResultLines - 1, 'commits')
          if (commits.length > count)
            kept.push(
              `… more commits; continue with rev=<last sha>~1 or raise limit (max ${MAX_LOG})`,
            )
          return kept.join('\n')
        },
      }),
      defineTool({
        name: 'git.diff',
        description:
          'What changed between two commits: --stat, then the patch (optionally of one path), capped with a note on what was cut. to defaults to HEAD; use it to see what changed since an earlier (e.g. last reviewed) commit.',
        input: z.object({
          from: z.string().min(1).describe('Older commit sha or ref'),
          to: z.string().optional().describe('Newer commit sha or ref, default HEAD'),
          path: z.string().optional().describe('Limit to this file or directory'),
        }),
        subject: ({ from, to }) => `${from} ${to ?? 'HEAD'}`,
        async run({ from, to = 'HEAD', path }, ctx) {
          const revs = [checkRev(from), checkRev(to)]
          const paths = pathArgs(path)
          const stat = await gitOk(
            runner,
            ['diff', ...DIFF_FLAGS, '--stat', ...revs, ...paths],
            revs,
            ctx,
          )
          const patch = await gitOk(
            runner,
            ['diff', ...DIFF_FLAGS, '--patch', ...revs, ...paths],
            revs,
            ctx,
          )
          const head = [
            `diff ${revs[0]} → ${revs[1]}${path ? ` (${checkPath(path)})` : ''}`,
            ...lines(stat),
          ]
          const body = lines(patch)
          if (!body.length) head.push('no changes')
          return capPatch(head, body, budget)
        },
      }),
      defineTool({
        name: 'git.blame',
        description: `Who last changed lines start..end (1-based, inclusive) of a file at rev (default HEAD): short sha, author, date and the line, at most ${blameMax} lines per call. Follow up with git.show on a sha to see why.`,
        input: z.object({
          path: z.string().min(1).describe('File path relative to the repository root'),
          start: z.number().int().min(1).describe('First line'),
          end: z.number().int().min(1).describe('Last line'),
          rev: z.string().optional().describe('Blame the file as of this commit, default HEAD'),
        }),
        subject: ({ path }) => path,
        async run({ path, start, end, rev = 'HEAD' }, ctx) {
          const file = checkPath(path)
          const at = checkRev(rev)
          if (end < start) throw new ToolError(`end (${end}) is before start (${start})`)
          const last = Math.min(end, start + blameMax - 1)
          const out = await gitOk(
            runner,
            ['blame', '--date=short', '-L', `${start},${last}`, at, '--', file],
            [at],
            ctx,
          )
          const annotated = lines(out).map((line) => clip(line, budget.maxLineLength))
          const result = [`${file} ${start}-${start + annotated.length - 1} at ${at}`, ...annotated]
          if (last < end) result.push(`… cut at ${blameMax} lines; continue with start=${last + 1}`)
          return result.join('\n')
        },
      }),
    ],
  }
}
