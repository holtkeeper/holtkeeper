import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandError } from '@holtkeeper/exec'
import type { QualityCheck } from '@holtkeeper/quality'

import { type LargeClone, parseJscpdReport } from './report.ts'

/** Paths skipped on top of `.gitignore`: dependencies, build output and lockfiles. */
export const defaultIgnore: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/vendor/**',
  '**/.git/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.lock',
  '**/*.lockb',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/go.sum',
  '**/Cargo.lock',
  '**/poetry.lock',
]

export interface DuplicationCheckOptions {
  /** Smallest clone in tokens (jscpd `--min-tokens`); jscpd's default (50) when unset. */
  minTokens?: number
  /** Smallest clone in lines (jscpd `--min-lines`); jscpd's default (5) when unset. */
  minLines?: number
  /** jscpd format names to scan, e.g. `['typescript', 'go']`; all formats when unset. */
  formats?: readonly string[]
  /** Extra globs to skip, added to `defaultIgnore`. */
  ignore?: readonly string[]
  /** Clones at or above these sizes are `warning`s instead of `info`. */
  large?: LargeClone
  /** The jscpd executable; defaults to the `jscpd` bin of this package's dependency. */
  bin?: string
  timeoutMs?: number
}

const bundledJscpd = () => join(import.meta.dir, '..', 'node_modules', '.bin', 'jscpd')

/** The jscpd command line for `options`, writing its JSON report into `output`. */
export function jscpdCommand(options: DuplicationCheckOptions, output: string): string[] {
  return [
    options.bin ?? bundledJscpd(),
    '--reporters',
    'json',
    '--output',
    output,
    '--silent',
    '--no-colors',
    '--ignore',
    [...defaultIgnore, ...(options.ignore ?? [])].join(','),
    ...(options.minTokens === undefined ? [] : ['--min-tokens', String(options.minTokens)]),
    ...(options.minLines === undefined ? [] : ['--min-lines', String(options.minLines)]),
    ...(options.formats?.length ? ['--format', options.formats.join(',')] : []),
    '.',
  ]
}

/**
 * Copy-paste detection with jscpd over the whole project (respecting `.gitignore` and
 * `defaultIgnore`). Contributes the `duplication` summary and one `duplication` issue per clone.
 * The report goes to a temporary directory on the machine running this code, so the runner must
 * share its filesystem.
 */
export function duplicationCheck(options: DuplicationCheckOptions = {}): QualityCheck {
  return {
    name: 'duplication',
    detect: async () => true,
    async run({ dir, runner, signal }) {
      const output = await mkdtemp(join(tmpdir(), 'holtkeeper-jscpd-'))
      try {
        const command = jscpdCommand(options, output)
        const runOptions = {
          cwd: dir,
          ...(signal ? { signal } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        }
        const versionResult = await runner.run([command[0] ?? 'jscpd', '--version'], runOptions)
        const version = /\d+\.\d+\.\d+\S*/.exec(versionResult.stdout)?.[0]

        const result = await runner.run(command, runOptions)
        const report = Bun.file(join(output, 'jscpd-report.json'))
        // A project `.jscpd.json` with a threshold makes jscpd exit 1 while still writing the report.
        if (!(await report.exists()) || result.exitCode > 1) throw new CommandError(command, result)

        const { duplication, issues } = parseJscpdReport(await report.text(), options.large)
        return { duplication, issues, ...(version ? { version } : {}) }
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    },
  }
}
