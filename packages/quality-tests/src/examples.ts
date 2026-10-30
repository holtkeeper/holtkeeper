import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Agent, AgentCapability } from '@holtkeeper/agent'
import type { CodeChange } from '@holtkeeper/changes'
import { stableId, type TestSuggestion } from '@holtkeeper/quality'
import { z } from 'zod'

import { singleTestCommand, testPathFor, testPathProblem } from './conventions.ts'
import { frameworkFor } from './detect.ts'
import { isListable, languageOf, listFiles } from './files.ts'
import type { TestConventions, TestFramework, TestSetup } from './types.ts'

/** What the agent must answer with. */
export const exampleTestSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
  notes: z.string(),
})

export type ExampleTest = z.infer<typeof exampleTestSchema>

export interface ExampleTestOptions {
  dir: string
  agent: Agent
  setup: TestSetup
  /** Ranked suggestions; examples are written for the first `count`. */
  suggestions: readonly TestSuggestion[]
  /** Default 3. */
  count?: number
  /** Let the agent run the single new test (grants the `run` capability). Default false. */
  verify?: boolean
  maxTurns?: number
  signal?: AbortSignal
}

export interface ExampleTestResult {
  /** All input suggestions; those with an example carry `changeId`, `testFile` and `framework`. */
  suggestions: TestSuggestion[]
  changes: CodeChange[]
  /** Targets the agent could not produce a usable test for, and why. */
  failures: { suggestionId: string; error: string }[]
}

const SYSTEM = [
  'You write one focused, deterministic unit test file that matches the project’s existing tests in framework, layout, naming, imports and style.',
  'Test observable behavior through the public API. No network, no real external services, no sleeping.',
].join('\n')

/** The prompt for one target; exported so its content is reviewable in tests. */
export function examplePrompt(
  suggestion: TestSuggestion,
  conventions: TestConventions,
  framework: TestFramework,
  samples: readonly string[],
  verify: boolean,
): string {
  const expected = testPathFor(conventions, suggestion.file)
  const range = suggestion.range
    ? ` (lines ${suggestion.range.start.line}–${suggestion.range.end.line - 1})`
    : ''
  const lines = [
    `Write a new test file for \`${suggestion.symbol}\` (${suggestion.kind}) in \`${suggestion.file}\`${range}.`,
    `Why it needs a test: ${suggestion.reason}.`,
    '',
    `Framework: ${framework}.`,
  ]
  if (conventions.frameworkImport)
    lines.push(
      `Import the framework the way existing tests do: \`${conventions.frameworkImport}\`.`,
    )
  if (conventions.localImportExtension) {
    const style = {
      '.ts': 'with the .ts extension (`./module.ts`)',
      '.js': 'with the .js extension (`./module.js`)',
      none: 'without an extension (`./module`)',
    }
    lines.push(`Existing tests import local modules ${style[conventions.localImportExtension]}.`)
  }
  if (samples.length) {
    lines.push(
      'Read these existing tests first and imitate their style:',
      ...samples.map((file) => `- ${file}`),
    )
  }
  lines.push(
    '',
    `Put the test at \`${expected}\` (the project convention: ${conventions.layout} tests named ${conventions.fileName}). If that file exists, choose another name that follows the same convention. The path must not exist yet.`,
    'Read the source of the target and what it depends on before writing. Cover the main path and the important branches.',
  )
  if (verify) {
    lines.push(
      `You may verify the test: write it to its path, run only it with \`${singleTestCommand(framework, expected).join(' ')}\` (adjust the path if you chose another), fix it until it passes, then delete the file. Do not change any other file.`,
    )
  } else {
    lines.push(
      'Do not create or modify files; you cannot run tests. Return the file content instead.',
    )
  }
  lines.push(
    '',
    'Answer with JSON only: {"path": "<test file path relative to the project root>", "content": "<the complete file>", "notes": "<what the test covers, assumptions, and whether it was run>"}',
  )
  return lines.join('\n')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Asks the agent for one example test per top suggestion, following the detected framework and
 * the sampled tests' style. Each accepted answer becomes a `review` `CodeChange` that creates the
 * test file, linked from its suggestion. The answer is rejected when its path breaks the
 * project's test location convention or names an existing file. A file the agent wrote only to
 * verify the test is removed again; nothing else in the checkout is changed.
 */
export async function writeExampleTests(options: ExampleTestOptions): Promise<ExampleTestResult> {
  const { dir, agent, setup, count = 3, verify = false } = options
  const suggestions = options.suggestions.map((suggestion) => ({ ...suggestion }))
  const changes: CodeChange[] = []
  const failures: ExampleTestResult['failures'] = []
  const capabilities: AgentCapability[] = verify ? ['read', 'search', 'run'] : ['read', 'search']

  for (const suggestion of suggestions.slice(0, count)) {
    options.signal?.throwIfAborted()
    const language = languageOf(suggestion.file)
    const conventions = setup.conventions.find((entry) => entry.language === language)
    const framework = language ? frameworkFor(setup, language) : undefined
    if (!conventions || !framework) {
      failures.push({
        suggestionId: suggestion.id,
        error: `no test framework detected for ${suggestion.file}`,
      })
      continue
    }
    const samples = setup.samples.filter((file) => languageOf(file) === language)
    try {
      // With `verify` the agent may write the test to run it; knowing what existed before tells
      // its scratch file apart from a file the project already had.
      // oxlint-disable-next-line no-await-in-loop
      const before = verify ? await listFiles(dir) : undefined
      // Sequential on purpose: with `verify` the agent runs tests in the shared checkout.
      // oxlint-disable-next-line no-await-in-loop
      const result = await agent.run({
        dir,
        system: SYSTEM,
        prompt: examplePrompt(suggestion, conventions, framework, samples, verify),
        capabilities,
        output: exampleTestSchema,
        ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const answer = result.output
      if (!answer) throw new Error('agent returned no structured answer')
      const path = answer.path.replace(/^\.\//, '')
      const problem = testPathProblem(conventions, suggestion.file, path)
      if (problem)
        throw new Error(`test path ${path} does not follow the project convention: ${problem}`)

      const absolute = join(dir, path)
      // oxlint-disable-next-line no-await-in-loop
      if (await exists(absolute)) {
        if (!before || before.length >= 20_000 || !isListable(path) || before.includes(path))
          throw new Error(`test path ${path} already exists`)
        // oxlint-disable-next-line no-await-in-loop
        await rm(absolute, { force: true })
      }

      const content = answer.content.endsWith('\n') ? answer.content : `${answer.content}\n`
      const change: CodeChange = {
        id: stableId('quality-tests', suggestion.id),
        title: `Add a test for ${suggestion.symbol}`,
        ...(answer.notes.trim() ? { description: answer.notes.trim() } : {}),
        confidence: 'review',
        source: agent.name,
        edits: [{ kind: 'create', file: path, newText: content }],
      }
      changes.push(change)
      suggestion.changeId = change.id
      suggestion.testFile = path
      suggestion.framework = framework
    } catch (error) {
      options.signal?.throwIfAborted()
      failures.push({
        suggestionId: suggestion.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { suggestions, changes, failures }
}
