import type { TestSuggestion } from '@holtkeeper/quality'
import { examplePrompt } from '@holtkeeper/quality-tests'
import { type FileScope, renderNumberedDiff } from '@holtkeeper/review'
import { z } from 'zod'

import type { TestTarget } from './targets.ts'

export const SYSTEM = [
  'You write one focused, deterministic test file for code a merge request changes, matching the project’s existing tests in framework, layout, naming, imports and style.',
  'Test the behavior the merge request intends, through the public API. No network, no real external services, no sleeping.',
  'Holtkeeper writes your file and runs it; you only answer with its content.',
].join('\n')

/** The answer to a request for a fix after a failed run. */
export const fixSchema = z.object({
  /** `code-wrong`: the code contradicts what the merge request intends, the test is right. */
  verdict: z.enum(['fixed', 'code-wrong']),
  /** The complete test file; for `code-wrong` the version that shows the problem. */
  content: z.string(),
  notes: z.string(),
})

const MAX_DESCRIPTION = 2000

/** The merge request's lines of the target's file that fall inside the target function. */
export function targetDiff(target: TestTarget, file: Pick<FileScope, 'hunks' | 'lines'>): string {
  const inside = new Set(
    [...file.lines].filter((line) => line >= target.startLine && line <= target.endLine),
  )
  return renderNumberedDiff(target.path, file.hunks, inside)
}

function intent(mergeRequest: { title: string; description: string }, diff: string): string[] {
  const description = mergeRequest.description.trim()
  return [
    '',
    `The merge request: ${mergeRequest.title}`,
    ...(description
      ? [
          description.length > MAX_DESCRIPTION
            ? `${description.slice(0, MAX_DESCRIPTION)}…`
            : description,
        ]
      : []),
    ...(diff
      ? [
          '',
          'What it changes in the function (`+` added lines, `-` removed lines):',
          '```diff',
          diff,
          '```',
        ]
      : []),
  ]
}

/** The first request: a new test file for the target, under the project's conventions. */
export function writePrompt(options: {
  target: TestTarget
  samples: readonly string[]
  mergeRequest: { title: string; description: string }
  diff: string
  /** Test paths other targets of this run use. */
  taken: readonly string[]
}): string {
  const { target } = options
  const suggestion: TestSuggestion = {
    id: target.id,
    file: target.path,
    symbol: target.symbol,
    kind: target.kind,
    range: {
      start: { line: target.startLine, column: 1 },
      end: { line: target.endLine + 1, column: 1 },
    },
    reason: 'the merge request changes it',
  }
  return [
    examplePrompt(suggestion, target.conventions, target.framework, options.samples, false),
    ...intent(options.mergeRequest, options.diff),
    ...(options.taken.length
      ? ['', `These paths are taken, choose another: ${options.taken.join(', ')}.`]
      : []),
    '',
    'Cover the changed behavior first. Holtkeeper runs the file and sends you the output if it fails.',
  ].join('\n')
}

/** A follow-up after a failed run: fix the test, or say the code is wrong. */
export function fixPrompt(options: {
  target: TestTarget
  testFile: string
  content: string
  command: readonly string[]
  output: string
  mergeRequest: { title: string; description: string }
  diff: string
}): string {
  const { target } = options
  return [
    `Holtkeeper ran your test for \`${target.symbol}\` in \`${target.path}\` (lines ${target.startLine}–${target.endLine}) with \`${options.command.join(' ')}\` and it failed.`,
    ...intent(options.mergeRequest, options.diff),
    '',
    `The test file \`${options.testFile}\`:`,
    '```',
    options.content.replace(/\n$/, ''),
    '```',
    '',
    'Output:',
    '```',
    options.output,
    '```',
    '',
    'Read the code again and decide:',
    '- the test is wrong (wrong import, setup, expectation): answer `fixed` with the complete corrected file;',
    '- the code contradicts what the merge request intends: answer `code-wrong`, keep the assertion that shows it, and explain in `notes` what was expected and what the code does.',
    'Never weaken an assertion only to make wrong behavior pass. The path stays the same.',
    '',
    'Answer with JSON only: {"verdict": "fixed" | "code-wrong", "content": "<the complete file>", "notes": "<what changed or why the code is wrong>"}',
  ].join('\n')
}
