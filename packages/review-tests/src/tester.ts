import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'

import type { AgentCapability } from '@holtkeeper/agent'
import { buildWorkspaces, installDependencies } from '@holtkeeper/coverage'
import {
  type TestSetup,
  detectTestSetup,
  exampleTestSchema,
  findFunctions,
  languageOf,
  testPathFor,
  testPathProblem,
} from '@holtkeeper/quality-tests'
import type {
  FileScope,
  MergeRequestTestInput,
  MergeRequestTester,
  ReviewTest,
  ReviewTestRun,
} from '@holtkeeper/review'

import { SYSTEM, fixPrompt, fixSchema, targetDiff, writePrompt } from './prompt.ts'
import { runTest, tail, testCommand } from './run.ts'
import { type NotTested, type TestTarget, findTargets, functionHash, outermost } from './targets.ts'

export interface MergeRequestTesterOptions {
  /** Install JavaScript dependencies when `node_modules` is missing. Default true. */
  install?: boolean
  /** Let that install run lifecycle scripts. Default false. */
  installScripts?: boolean
  /** Build workspace packages whose entry files are missing. Default true. */
  build?: boolean
  /** In-scope added lines a function needs to get a test. Default 3. */
  minLines?: number
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists()
}

/**
 * Previous tests whose function is unchanged: same file, same name, same text. They are kept as
 * they were instead of being written and run again.
 */
async function unchangedPrevious(
  dir: string,
  previous: readonly ReviewTest[],
): Promise<ReviewTest[]> {
  const kept: ReviewTest[] = []
  for (const test of previous) {
    const language = languageOf(test.target.path)
    const file = Bun.file(join(dir, test.target.path))
    // oxlint-disable-next-line no-await-in-loop
    if (!language || !(await file.exists()) || (await exists(join(dir, test.testFile)))) continue
    // oxlint-disable-next-line no-await-in-loop
    const text = await file.text()
    const fn = outermost(findFunctions(text, language)).find((f) => f.name === test.target.symbol)
    if (fn && functionHash(text, fn) === test.target.hash)
      kept.push({
        ...test,
        target: { ...test.target, startLine: fn.startLine, endLine: fn.endLine },
      })
  }
  return kept
}

/** What to remove to undo writing `file`: the file, or the outermost folder that is missing. */
function scratchOf(dir: string, file: string): string {
  let removable = file
  let folder = posix.dirname(file)
  while (folder !== '.' && !existsSync(join(dir, folder))) {
    removable = folder
    folder = posix.dirname(folder)
  }
  return join(dir, removable)
}

async function writeFile(dir: string, file: string, content: string) {
  const absolute = join(dir, file)
  await mkdir(dirname(absolute), { recursive: true })
  await Bun.write(absolute, content)
}

const withNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`)

const pick = (target: TestTarget) => ({ path: target.path, symbol: target.symbol })

const capabilities: AgentCapability[] = ['read', 'search']

interface Context {
  input: MergeRequestTestInput
  setup: TestSetup
  files: Map<string, FileScope>
}

async function testTarget(
  context: Context,
  target: TestTarget,
  taken: readonly string[],
): Promise<ReviewTest | NotTested> {
  const { input, setup } = context
  const { dir, agent, options } = input
  const file = context.files.get(target.path)
  const diff = file ? targetDiff(target, file) : ''
  const samples = setup.samples.filter((sample) => languageOf(sample) === target.language)
  const task = {
    dir,
    system: SYSTEM,
    capabilities,
    taskKind: 'tests',
    ...(input.toolsets ? { toolsets: [...input.toolsets] } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }

  const first = await agent.run({
    ...task,
    prompt: writePrompt({
      target,
      samples,
      mergeRequest: input.mergeRequest,
      diff,
      taken,
    }),
    output: exampleTestSchema,
  })
  if (!first.output) return { ...pick(target), reason: 'the agent returned no test' }
  const testFile = first.output.path.replace(/^\.\//, '')
  const problem =
    testPathProblem(target.conventions, target.path, testFile) ??
    (taken.includes(testFile) ? 'path used by another test of this run' : undefined) ??
    ((await exists(join(dir, testFile))) ? 'file already exists' : undefined)
  if (problem) return { ...pick(target), reason: `unusable test path ${testFile}: ${problem}` }

  const { cwd, command } = testCommand(dir, target.language, target.framework, testFile)
  const run = () =>
    runTest({
      runner: input.runner,
      dir,
      cwd,
      command,
      timeoutMs: options.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    })

  let content = withNewline(first.output.content)
  let notes = first.output.notes.trim()
  let attempts = 1
  let reason: string | undefined
  let last = { passed: false, durationMs: 0, output: '' }
  const scratch = scratchOf(dir, testFile)
  try {
    for (;;) {
      input.signal?.throwIfAborted()
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(dir, testFile, content)
      // oxlint-disable-next-line no-await-in-loop
      last = await run()
      if (last.passed) break
      if (attempts >= options.attempts) {
        reason = `did not pass in ${attempts} attempt(s)`
        break
      }
      attempts++
      // oxlint-disable-next-line no-await-in-loop
      const fix = await agent.run({
        ...task,
        prompt: fixPrompt({
          target,
          testFile,
          content,
          command,
          output: last.output,
          mergeRequest: input.mergeRequest,
          diff,
        }),
        output: fixSchema,
      })
      if (!fix.output) {
        reason = 'the agent returned no fix'
        break
      }
      content = withNewline(fix.output.content)
      notes = fix.output.notes.trim() || notes
      if (fix.output.verdict === 'code-wrong') {
        reason = `the agent judges the code wrong: ${notes}`
        break
      }
    }

    let passed = last.passed ? 1 : 0
    let runs = 1
    let durationMs = last.durationMs
    let failedOutput = last.passed ? undefined : last.output
    if (last.passed)
      while (runs < options.repeat) {
        // oxlint-disable-next-line no-await-in-loop
        const again = await run()
        runs++
        durationMs = Math.max(durationMs, again.durationMs)
        if (again.passed) passed++
        else failedOutput = again.output
      }
    const verdict = !last.passed ? 'unfinished' : passed === runs ? 'passes' : 'flaky'
    if (verdict === 'flaky') reason = `passed ${passed} of ${runs} runs`
    return {
      id: target.id,
      target: {
        path: target.path,
        symbol: target.symbol,
        startLine: target.startLine,
        endLine: target.endLine,
        hash: target.hash,
      },
      testFile,
      framework: target.framework,
      command,
      cwd,
      verdict,
      head: { passed, runs, durationMs },
      attempts,
      content,
      ...(notes ? { notes } : {}),
      ...(reason ? { reason } : {}),
      ...(failedOutput ? { output: tail(failedOutput) } : {}),
      ranAt: input.headSha,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * The `MergeRequestTester` on `quality-tests`: finds the outermost changed functions, prepares the
 * checkout (install, workspace builds), skips functions whose existing test already fails, then
 * per function lets the agent write a test, runs it itself, sends failures back for at most
 * `attempts` rounds and reruns a passing test `repeat` times. Only the test file is written, and
 * it is removed again after its runs.
 */
export function createMergeRequestTester(
  testerOptions: MergeRequestTesterOptions = {},
): MergeRequestTester {
  return {
    async test(input): Promise<ReviewTestRun> {
      const { dir, options } = input
      const log = input.log ?? (() => {})
      const setup = await detectTestSetup(dir)
      const carried = await unchangedPrevious(dir, input.previous ?? [])
      if (!setup.frameworks.length)
        return { skipped: 'no test framework detected', items: carried, notTested: [] }

      const found = await findTargets({
        dir,
        files: input.files,
        setup,
        minLines: testerOptions.minLines ?? 3,
        components: options.components ?? false,
      })
      const carriedIds = new Set(carried.map((test) => test.id))
      const fresh = found.targets.filter((target) => !carriedIds.has(target.id))
      const notTested: NotTested[] = [
        ...found.notTested,
        ...fresh.slice(options.maxTests).map((target) => ({
          ...pick(target),
          reason: `over the limit of ${options.maxTests} test(s) per run`,
        })),
      ]
      const selected = fresh.slice(0, options.maxTests)
      if (!selected.length) return { items: carried, notTested }

      if (selected.some((target) => target.language === 'js')) {
        if (testerOptions.install ?? true) {
          const installed = await installDependencies({
            dir,
            runner: input.runner,
            ...(testerOptions.installScripts ? { scripts: true } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          })
          if (installed.status === 'failed')
            return {
              skipped: `installing dependencies failed: ${tail(installed.error, 5, 500)}`,
              items: carried,
              notTested,
            }
        }
        if (testerOptions.build ?? true) {
          const built = await buildWorkspaces({
            dir,
            runner: input.runner,
            ...(input.signal ? { signal: input.signal } : {}),
          })
          if (built.status === 'failed')
            return {
              skipped: `building workspace packages failed: ${tail(built.error, 5, 500)}`,
              items: carried,
              notTested,
            }
        }
      }

      const context: Context = {
        input,
        setup,
        files: new Map(input.files.map((file) => [file.path, file])),
      }
      const baseline = new Map<string, boolean>()
      const items: ReviewTest[] = [...carried]
      const taken: string[] = []
      for (const target of selected) {
        input.signal?.throwIfAborted()
        const existing = testPathFor(target.conventions, target.path)
        // oxlint-disable-next-line no-await-in-loop
        if (!baseline.has(existing) && (await exists(join(dir, existing)))) {
          const { cwd, command } = testCommand(dir, target.language, target.framework, existing)
          // oxlint-disable-next-line no-await-in-loop
          const result = await runTest({
            runner: input.runner,
            dir,
            cwd,
            command,
            timeoutMs: options.timeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
          })
          baseline.set(existing, result.passed)
        }
        if (baseline.get(existing) === false) {
          notTested.push({
            ...pick(target),
            reason: `its existing test ${existing} fails on the head`,
          })
          continue
        }
        log(`writing a test for ${target.symbol} in ${target.path}`)
        try {
          // oxlint-disable-next-line no-await-in-loop
          const result = await testTarget(context, target, taken)
          if ('verdict' in result) {
            items.push(result)
            taken.push(result.testFile)
            log(`${result.testFile}: ${result.verdict}`)
          } else notTested.push(result)
        } catch (error) {
          input.signal?.throwIfAborted()
          notTested.push({ ...pick(target), reason: message(error) })
        }
      }
      return { items, notTested }
    },
  }
}
