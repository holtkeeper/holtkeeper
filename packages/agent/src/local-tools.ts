import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'
import { z } from 'zod'

import { resolveInside } from './paths.ts'
import type { AgentCapability, AgentTool, ToolContext } from './types.ts'

/** Limits of the built-in file and command tools of adapters that run their own tool loop. */
export interface LocalToolLimits {
  /** Characters a single tool result may return; longer output is cut and marked. */
  maxOutputChars: number
  /** Lines `read_file` returns without an explicit `limit`. */
  maxReadLines: number
  /** Entries `glob` and `grep` list at most. */
  maxEntries: number
  /** Default timeout of `run_command`. */
  commandTimeoutMs: number
}

export const DEFAULT_LOCAL_TOOL_LIMITS: LocalToolLimits = {
  maxOutputChars: 30_000,
  maxReadLines: 2000,
  maxEntries: 200,
  commandTimeoutMs: 120_000,
}

function tool<Input extends z.ZodObject>(definition: {
  name: string
  description: string
  input: Input
  run(input: z.infer<Input>, ctx: ToolContext): Promise<string> | string
}): AgentTool {
  return definition
}

const SKIPPED = /(^|\/)(node_modules|\.git|dist|build|coverage|vendor|\.next|\.turbo|\.cache)(\/|$)/
const MAX_GREP_BYTES = 1_000_000

/** `text` cut to `max` characters with a marker saying how much was left out. */
export function clipOutput(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`
}

function relativeTo(dir: string, path: string): string {
  return relative(dir, path).split(sep).join('/')
}

function checkPattern(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split('/').includes('..'))
    throw new Error(`${pattern} is outside the working directory`)
}

async function files(dir: string, root: string, pattern: string, signal: AbortSignal) {
  checkPattern(pattern)
  const found: string[] = []
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
    signal.throwIfAborted()
    const rel = relativeTo(dir, resolveInside(root, file))
    if (!SKIPPED.test(rel)) found.push(rel)
  }
  return found.toSorted()
}

/**
 * The tools a capability grants in adapters with their own tool loop, confined to the task
 * directory: `read` → `read_file`, `glob`; `search` → `grep`; `edit` → `edit_file`,
 * `write_file`; `run` → `run_command`, only with a `runner` (without one `run` grants nothing).
 * Paths outside the directory (symlinks resolved) are refused with an error result.
 */
export function localTools(
  capabilities: readonly AgentCapability[],
  options: { runner?: CommandRunner; limits?: Partial<LocalToolLimits> } = {},
): AgentTool[] {
  const limits = { ...DEFAULT_LOCAL_TOOL_LIMITS, ...options.limits }
  const granted = new Set(capabilities)
  const tools: AgentTool[] = []
  const clip = (text: string) => clipOutput(text, limits.maxOutputChars)

  if (granted.has('read')) {
    tools.push(
      tool({
        name: 'read_file',
        description:
          'Read a text file in the repository. Returns numbered lines. Use offset/limit (1-based line numbers) for large files.',
        input: z.object({
          path: z.string().min(1).describe('Path relative to the repository root'),
          offset: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).optional(),
        }),
        async run({ path, offset = 1, limit = limits.maxReadLines }, { dir }) {
          const lines = (await readFile(resolveInside(dir, path), 'utf8')).split(/\r?\n/)
          const slice = lines.slice(offset - 1, offset - 1 + limit)
          const body = slice.map((line, index) => `${offset + index}\t${line}`).join('\n')
          const rest = lines.length - (offset - 1 + slice.length)
          return clip(rest > 0 ? `${body}\n… ${rest} more lines` : body)
        },
      }),
      tool({
        name: 'glob',
        description:
          'List repository files matching a glob pattern such as "src/**/*.ts". Dependencies and build output are skipped.',
        input: z.object({
          pattern: z.string().min(1),
          path: z.string().optional().describe('Directory to search from; default the root'),
        }),
        async run({ pattern, path = '.' }, { dir, signal }) {
          const found = await files(dir, resolveInside(dir, path), pattern, signal)
          if (!found.length) return 'no files found'
          const shown = found.slice(0, limits.maxEntries)
          const more = found.length - shown.length
          return clip([...shown, ...(more > 0 ? [`… ${more} more files`] : [])].join('\n'))
        },
      }),
    )
  }

  if (granted.has('search')) {
    tools.push(
      tool({
        name: 'grep',
        description:
          'Search file contents with a regular expression. Returns "path:line: text" for each match.',
        input: z.object({
          pattern: z.string().min(1).describe('JavaScript regular expression'),
          glob: z.string().optional().describe('Files to search, default "**/*"'),
          path: z.string().optional().describe('Directory to search from; default the root'),
          ignoreCase: z.boolean().optional(),
        }),
        async run({ pattern, glob = '**/*', path = '.', ignoreCase }, { dir, signal }) {
          const regex = new RegExp(pattern, ignoreCase ? 'i' : undefined)
          const matches: string[] = []
          for (const file of await files(dir, resolveInside(dir, path), glob, signal)) {
            if (matches.length >= limits.maxEntries) break
            const absolute = resolveInside(dir, file)
            // oxlint-disable-next-line no-await-in-loop -- stops early once enough matches are found
            if ((await stat(absolute)).size > MAX_GREP_BYTES) continue
            // oxlint-disable-next-line no-await-in-loop -- see above
            const text = await readFile(absolute, 'utf8')
            if (text.slice(0, 8000).includes('\0')) continue
            for (const [index, line] of text.split(/\r?\n/).entries()) {
              if (!regex.test(line)) continue
              matches.push(`${file}:${index + 1}: ${line.slice(0, 300)}`)
              if (matches.length >= limits.maxEntries) break
            }
          }
          if (!matches.length) return 'no matches'
          const full =
            matches.length >= limits.maxEntries ? ['… more matches; narrow the search'] : []
          return clip([...matches, ...full].join('\n'))
        },
      }),
    )
  }

  if (granted.has('edit')) {
    tools.push(
      tool({
        name: 'edit_file',
        description:
          'Replace an exact piece of text in a file. old_string must occur exactly once unless replace_all is true.',
        input: z.object({
          path: z.string().min(1),
          old_string: z.string().min(1),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        }),
        async run({ path, old_string, new_string, replace_all }, { dir }) {
          const file = resolveInside(dir, path)
          const text = await readFile(file, 'utf8')
          const count = text.split(old_string).length - 1
          if (count === 0) throw new Error(`old_string not found in ${path}`)
          if (count > 1 && !replace_all)
            throw new Error(
              `old_string occurs ${count} times in ${path}; add context or set replace_all`,
            )
          await writeFile(
            file,
            text.replaceAll(old_string, () => new_string),
          )
          return `edited ${path}: ${replace_all ? count : 1} replacement(s)`
        },
      }),
      tool({
        name: 'write_file',
        description: 'Create or overwrite a file with the given content.',
        input: z.object({ path: z.string().min(1), content: z.string() }),
        async run({ path, content }, { dir }) {
          const file = resolveInside(dir, path)
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, content)
          return `wrote ${path} (${content.length} characters)`
        },
      }),
    )
  }

  const runner = options.runner
  if (granted.has('run') && runner) {
    tools.push(
      tool({
        name: 'run_command',
        description:
          'Run a shell command in the repository root, e.g. tests or a linter. Returns the exit code and output.',
        input: z.object({
          command: z.string().min(1),
          timeout_ms: z.number().int().min(1000).max(600_000).optional(),
        }),
        async run({ command, timeout_ms }, { dir, signal }) {
          const result = await runner.run(['sh', '-c', command], {
            cwd: dir,
            signal,
            timeoutMs: timeout_ms ?? limits.commandTimeoutMs,
          })
          const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
          return clip(`exit code ${result.exitCode}${output ? `\n${output}` : ''}`)
        },
      }),
    )
  }
  return tools
}
