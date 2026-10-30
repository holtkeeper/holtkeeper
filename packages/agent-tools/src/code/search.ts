import { join } from 'node:path'

import type { AgentTool } from '@holtkeeper/agent'
import { z } from 'zod'

import { type Budget, clip, renderBlocks } from '../budget.ts'
import { listFiles, readText, splitLines } from '../files.ts'
import { defineTool } from '../tool.ts'
import { LANGUAGE_EXTENSIONS, LANGUAGES, linesOf, parseSource } from './syntax.ts'

const paths = z
  .array(z.string())
  .optional()
  .describe('Glob patterns relative to the repository root, e.g. ["packages/a/src/**"]')

/** Snippet lines of a match: at most `max`, the rest summarized. */
function snippet(text: string, budget: Budget): string[] {
  const lines = text.split('\n')
  const shown = lines
    .slice(0, budget.snippetLines)
    .map((line) => `  ${clip(line, budget.maxLineLength)}`)
  if (lines.length > budget.snippetLines)
    shown.push(`  … ${lines.length - budget.snippetLines} more lines`)
  return shown
}

/** `code.search`: structural search with an ast-grep pattern. */
export function searchTool(budget: Budget): AgentTool {
  return defineTool({
    name: 'code.search',
    description:
      'Structural code search with an ast-grep pattern ($X matches one node, $$$ any number), e.g. "useEffect($$$)" or "import $A from \'lodash\'". Returns file:line and a short snippet per match. Cheaper than grep for code shapes; follow up with code.read for context.',
    input: z.object({
      pattern: z.string().min(1).describe('ast-grep pattern'),
      language: z.enum(LANGUAGES).describe('Parser; only files of this language are searched'),
      paths,
    }),
    async run({ pattern, language, paths: globs }, { dir, signal }) {
      const files = await listFiles(dir, {
        extensions: LANGUAGE_EXTENSIONS[language],
        signal,
        ...(globs ? { globs } : {}),
      })
      const blocks: string[][] = []
      for (const file of files) {
        signal.throwIfAborted()
        const text = await readText(join(dir, file))
        if (text === undefined) continue
        let matches
        try {
          matches = parseSource(language, text).findAll(pattern)
        } catch (error) {
          throw new Error(
            `invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
        for (const match of matches)
          blocks.push([`${file}:${linesOf(match).start}`, ...snippet(match.text(), budget)])
      }
      if (blocks.length === 0) return `no matches in ${files.length} ${language} files`
      return renderBlocks(blocks, budget, 'matches')
    },
  })
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `code.grep`: text search with context lines. */
export function grepTool(budget: Budget): AgentTool {
  return defineTool({
    name: 'code.grep',
    description:
      'Text search over repository files (node_modules, build output and hidden directories skipped). Returns matching lines as "line: text" grouped by file, with optional context lines ("line- text"). Use it for strings, comments and config; use code.search or code.references for code.',
    input: z.object({
      query: z.string().min(1),
      regex: z.boolean().optional().describe('Treat query as a JavaScript regular expression'),
      ignoreCase: z.boolean().optional(),
      context: z.number().int().min(0).max(3).optional().describe('Lines around each match, 0-3'),
      paths,
    }),
    async run({ query, regex, ignoreCase, context = 0, paths: globs }, { dir, signal }) {
      let matcher: RegExp
      try {
        matcher = new RegExp(regex ? query : escapeRegExp(query), ignoreCase ? 'im' : 'm')
      } catch (error) {
        throw new Error(
          `invalid regex: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      const files = await listFiles(dir, { signal, ...(globs ? { globs } : {}) })
      const blocks: string[][] = []
      let total = 0
      for (const file of files) {
        signal.throwIfAborted()
        const text = await readText(join(dir, file))
        if (text === undefined || !matcher.test(text)) continue
        const lines = splitLines(text)
        const hits = lines.flatMap((line, index) => (matcher.test(line) ? [index] : []))
        if (hits.length === 0) continue
        total += hits.length
        const shown = new Set<number>()
        for (const hit of hits)
          for (
            let i = Math.max(0, hit - context);
            i <= Math.min(lines.length - 1, hit + context);
            i++
          )
            shown.add(i)
        const hitSet = new Set(hits)
        const block = [file]
        let previous = -2
        for (const index of [...shown].toSorted((a, b) => a - b)) {
          if (context > 0 && previous >= 0 && index > previous + 1) block.push('  --')
          const separator = hitSet.has(index) ? ':' : '-'
          block.push(`  ${index + 1}${separator} ${clip(lines[index] ?? '', budget.maxLineLength)}`)
          previous = index
        }
        blocks.push(block)
      }
      if (blocks.length === 0) return `no matches in ${files.length} files`
      return `${total} matches in ${blocks.length} files\n${renderBlocks(blocks, { ...budget, maxResultLines: budget.maxResultLines - 1 }, 'files with matches')}`
    },
  })
}
