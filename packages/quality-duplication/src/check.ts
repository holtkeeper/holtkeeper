import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { CommandError } from '@holtkeeper/exec'
import type { QualityCheck } from '@holtkeeper/quality'

import { type LargeClone, parseJscpdReport } from './report.ts'

/**
 * Paths skipped on top of `.gitignore`: dependencies, build output, lockfiles, data and asset
 * files (JSON, SVG, source maps, snapshots), prose and configuration (Markdown such as generated
 * changelogs, YAML and templates such as Helm charts and CI, HTML such as generated API docs) and
 * generated code, whose repetition is not
 * copy-pasted code.
 */
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
  '**/*.json',
  '**/*.svg',
  '**/*.map',
  '**/*.snap',
  '**/__snapshots__/**',
  '**/*.md',
  '**/*.mdx',
  '**/*.yml',
  '**/*.yaml',
  '**/*.tpl',
  '**/*.gotmpl',
  '**/*.html',
  '**/*.htm',
  '**/generated/**',
  '**/__generated__/**',
  '**/*.pb.*',
  '**/*_pb.*',
  '**/*_pb2.py',
  '**/*.generated.*',
]

/** Tests and stories, skipped unless `tests` is set: their repeated setup is usually deliberate. */
export const testIgnore: readonly string[] = [
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.go',
  '**/test_*.py',
  '**/*.stories.*',
  '**/*.story.*',
]

/** `minTokens` when unset: smaller clones are mostly imports, props and boilerplate. */
export const defaultMinTokens = 100

export interface DuplicationCheckOptions {
  /** Smallest clone in tokens (jscpd `--min-tokens`); `defaultMinTokens` (100) when unset. */
  minTokens?: number
  /** Smallest clone in lines (jscpd `--min-lines`); jscpd's default (5) when unset. */
  minLines?: number
  /** jscpd format names to scan, e.g. `['typescript', 'go']`; all formats when unset. */
  formats?: readonly string[]
  /** Extra globs to skip, added to `defaultIgnore`. */
  ignore?: readonly string[]
  /** Whether tests and stories are scanned too. Default false (`testIgnore` is skipped). */
  tests?: boolean
  /** Clones at or above these sizes are `warning`s instead of `info`. */
  large?: LargeClone
  /**
   * The jscpd executable; defaults to the native binary of this package's jscpd dependency, so no
   * Node.js is needed, or its `jscpd` bin when that binary is missing.
   */
  bin?: string
  timeoutMs?: number
}

const PLATFORM_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  'linux-x64': ['jscpd-linux-x64-gnu', 'jscpd-linux-x64-musl'],
  'linux-arm64': ['jscpd-linux-arm64-gnu', 'jscpd-linux-arm64-musl'],
  'darwin-x64': ['jscpd-darwin-x64'],
  'darwin-arm64': ['jscpd-darwin-arm64'],
  'win32-x64': ['jscpd-windows-x64-msvc'],
  'win32-arm64': ['jscpd-windows-arm64-msvc'],
}

function bundledJscpd(): string {
  const shim = join(import.meta.dir, '..', 'node_modules', '.bin', 'jscpd')
  try {
    // The package's bin is a `#!/usr/bin/env node` launcher; the worker image has no Node.js.
    const root = dirname(Bun.resolveSync('jscpd/package.json', import.meta.dir))
    for (const name of PLATFORM_PACKAGES[`${process.platform}-${process.arch}`] ?? []) {
      try {
        const bin = join(
          dirname(Bun.resolveSync(`${name}/package.json`, root)),
          'bin',
          process.platform === 'win32' ? 'jscpd.exe' : 'jscpd',
        )
        if (existsSync(bin)) return bin
      } catch {
        continue
      }
    }
  } catch {
    return shim
  }
  return shim
}

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
    [...defaultIgnore, ...(options.tests ? [] : testIgnore), ...(options.ignore ?? [])].join(','),
    '--min-tokens',
    String(options.minTokens ?? defaultMinTokens),
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
