import type { AgentTool } from '@holtkeeper/agent'
import { z } from 'zod'

import { type Budget, clip } from '../budget.ts'
import {
  MAX_FILE_BYTES,
  MAX_READ_BYTES,
  formatSize,
  insideDir,
  isLockfile,
  readFileText,
  relativePath,
  splitLines,
} from '../files.ts'
import { defineTool } from '../tool.ts'

/** `code.read`: a line range of one file, never more than the budget's line limit. */
export function readTool(budget: Budget): AgentTool {
  const max = budget.maxResultLines - 2
  return defineTool({
    name: 'code.read',
    description: `Read lines start..end (1-based, inclusive) of a file, at most ${max} lines per call, numbered. Find the range with code.outline, code.symbol or code.search first instead of reading from the top.`,
    input: z.object({
      path: z.string().min(1).describe('File path relative to the repository root'),
      start: z.number().int().min(1).optional().describe('First line, default 1'),
      end: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`Last line, default start + ${max - 1}`),
    }),
    async run({ path, start = 1, end }, { dir }) {
      const absolute = insideDir(dir, path)
      const lockfileHint = isLockfile(path) ? '; query it with lockfiles.resolve' : ''
      const read = await readFileText(absolute, MAX_READ_BYTES)
      if (!('text' in read)) {
        if (read.skipped === 'missing') throw new Error(`${path} is missing`)
        if (read.skipped === 'binary') throw new Error(`${path} is binary`)
        throw new Error(`${path} is ${formatSize(read.size)}, too large to read${lockfileHint}`)
      }
      const lines = splitLines(read.text)
      const name = relativePath(dir, absolute)
      const note =
        read.size > MAX_FILE_BYTES
          ? `${name} is ${formatSize(read.size)}: the search tools skip it, read it in slices${lockfileHint}`
          : ''
      if (start > lines.length)
        return [note, `${name} has ${lines.length} lines`].filter(Boolean).join('\n')
      const limit = note ? max - 1 : max
      const wanted = Math.min(end ?? start + limit - 1, lines.length)
      const last = Math.min(wanted, start + limit - 1)
      const width = String(last).length
      const out = [...(note ? [note] : []), `${name} ${start}-${last} of ${lines.length}`]
      for (let line = start; line <= last; line++)
        out.push(
          `${String(line).padStart(width)}| ${clip(lines[line - 1] ?? '', budget.maxLineLength)}`,
        )
      if (last < lines.length)
        out.push(
          `… ${lines.length - last} more lines in the file (continue with start=${last + 1})`,
        )
      return out.join('\n')
    },
  })
}
