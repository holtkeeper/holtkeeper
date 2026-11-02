import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'
import { type TestFramework, type TestLanguage, singleTestCommand } from '@holtkeeper/quality-tests'

const projectMarkers: Record<TestLanguage, string[]> = {
  js: ['package.json'],
  go: ['go.mod'],
  python: [],
}

/**
 * Where to run one test file and the command to run it with: from the nearest folder above it
 * that holds the language's project file (`package.json`, `go.mod`), so workspace packages use
 * their own test config; from the root otherwise. `cwd` is relative to `dir`, `.` for the root.
 */
export function testCommand(
  dir: string,
  language: TestLanguage,
  framework: TestFramework,
  testFile: string,
): { cwd: string; command: string[] } {
  const markers = projectMarkers[language]
  let current = posix.dirname(testFile)
  while (current !== '.') {
    const folder = current
    if (markers.some((marker) => existsSync(join(dir, folder, marker)))) break
    current = posix.dirname(current)
  }
  const cwd = current
  const relative = cwd === '.' ? testFile : posix.relative(cwd, testFile)
  return { cwd, command: singleTestCommand(framework, relative) }
}

/** Last `lines` lines of `text`, at most `chars` characters. */
export function tail(text: string, lines = 80, chars = 6000): string {
  const kept = text.trimEnd().split('\n').slice(-lines).join('\n')
  return kept.length > chars ? `…${kept.slice(-chars)}` : kept
}

export interface TestRunResult {
  passed: boolean
  durationMs: number
  /** Tail of stdout and stderr. */
  output: string
}

/** Runs one test command; a process that cannot start or runs over `timeoutMs` counts as failed. */
export async function runTest(options: {
  runner: CommandRunner
  dir: string
  cwd: string
  command: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
}): Promise<TestRunResult> {
  const started = performance.now()
  try {
    const result = await options.runner.run(options.command, {
      cwd: join(options.dir, options.cwd),
      timeoutMs: options.timeoutMs,
      env: { CI: 'true' },
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const durationMs = Math.round(performance.now() - started)
    const output = tail([result.stdout, result.stderr].filter(Boolean).join('\n'))
    const timedOut = result.exitCode !== 0 && durationMs >= options.timeoutMs
    return {
      passed: result.exitCode === 0,
      durationMs,
      output: timedOut ? `timed out after ${options.timeoutMs} ms\n${output}` : output,
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    return {
      passed: false,
      durationMs: Math.round(performance.now() - started),
      output: `could not start \`${options.command.join(' ')}\`: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
