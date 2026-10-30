import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { CommandError, type CommandRunner } from '@holtkeeper/exec'

import { type GoModule, parseGoCoverFunc, parseGoCoverProfile, withGoFunctions } from './gocover.ts'
import { languagesOf, parseLcov } from './lcov.ts'
import type {
  CoverageCollector,
  CoverageContext,
  CoverageReport,
  TestFramework,
  TestLanguage,
} from './types.ts'

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** Folder inside the checkout that coverage runs write to; removed after reading. */
async function scratchDir(dir: string): Promise<{ rel: string; abs: string }> {
  const rel = `.holtkeeper/coverage-${crypto.randomUUID().slice(0, 8)}`
  const abs = join(dir, rel)
  await mkdir(abs, { recursive: true })
  return { rel, abs }
}

function withLanguages(report: CoverageReport, languages: readonly TestLanguage[]): CoverageReport {
  return { ...report, languages: [...new Set([...report.languages, ...languages])] }
}

/** How to run one lcov-producing test command. */
export interface LcovCommand {
  name: string
  language: TestLanguage
  /** Command run in the project root; `out` is a relative folder for the report. */
  command(out: string): string[]
  /** Report path relative to `out`. Default `lcov.info`. */
  reportFile?: string
  timeoutMs?: number
}

/**
 * Runs the project's tests with lcov coverage and parses the report. Failing tests do not fail
 * collection as long as the report was written; a missing report throws `CommandError`.
 */
export function lcovCommandCollector(spec: LcovCommand): CoverageCollector {
  return {
    name: spec.name,
    async collect({ dir, runner, signal }: CoverageContext) {
      const out = await scratchDir(dir)
      try {
        const command = spec.command(out.rel)
        const result = await runner.run(command, {
          cwd: dir,
          timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        })
        let text: string
        try {
          text = await readFile(join(out.abs, spec.reportFile ?? 'lcov.info'), 'utf8')
        } catch {
          throw new CommandError(command, result)
        }
        return withLanguages(parseLcov(text, dir), [spec.language])
      } finally {
        await rm(out.abs, { recursive: true, force: true })
      }
    },
  }
}

function packageExec(dir: string): string[] {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return ['pnpm', 'exec']
  if (existsSync(join(dir, 'yarn.lock'))) return ['yarn']
  return ['npx', '--no-install']
}

/** Go modules declared by `go.mod` files at the root and one level of nesting. */
export async function goModules(dir: string): Promise<GoModule[]> {
  const modules: GoModule[] = []
  const candidates = ['']
  try {
    const glob = new Bun.Glob('*/go.mod')
    for await (const path of glob.scan({ cwd: dir }))
      candidates.push(path.slice(0, -'/go.mod'.length))
  } catch {
    // unreadable directory: root only
  }
  for (const rel of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      const text = await readFile(join(dir, rel, 'go.mod'), 'utf8')
      const path = /^module\s+(\S+)/m.exec(text)?.[1]
      if (path) modules.push({ path, dir: rel })
    } catch {
      // no module here
    }
  }
  return modules
}

async function goFunctions(
  runner: CommandRunner,
  dir: string,
  profile: string,
  signal?: AbortSignal,
) {
  try {
    const result = await runner.run(['go', 'tool', 'cover', `-func=${profile}`], {
      cwd: dir,
      ...(signal ? { signal } : {}),
    })
    return result.exitCode === 0 ? result.stdout : undefined
  } catch {
    return undefined
  }
}

/** Runs `go test ./... -coverprofile` and names functions with `go tool cover -func`. */
export function goCoverageCollector(options: { timeoutMs?: number } = {}): CoverageCollector {
  return {
    name: 'go test -coverprofile',
    async collect({ dir, runner, signal }) {
      const out = await scratchDir(dir)
      try {
        const profile = `${out.rel}/cover.out`
        const command = ['go', 'test', './...', `-coverprofile=${profile}`]
        const result = await runner.run(command, {
          cwd: dir,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        })
        let text: string
        try {
          text = await readFile(join(dir, profile), 'utf8')
        } catch {
          throw new CommandError(command, result)
        }
        const modules = await goModules(dir)
        const report = parseGoCoverProfile(text, modules)
        const functions = await goFunctions(runner, dir, profile, signal)
        return functions ? withGoFunctions(report, parseGoCoverFunc(functions, modules)) : report
      } finally {
        await rm(out.abs, { recursive: true, force: true })
      }
    },
  }
}

/** The collector that runs `framework`'s tests with coverage in the project. */
export function collectorFor(framework: TestFramework, dir: string): CoverageCollector {
  const exec = () => packageExec(dir)
  switch (framework) {
    case 'bun:test':
      return lcovCommandCollector({
        name: 'bun test --coverage',
        language: 'js',
        command: (out) => [
          'bun',
          'test',
          '--coverage',
          '--coverage-reporter=lcov',
          `--coverage-dir=${out}`,
        ],
      })
    case 'vitest':
      return lcovCommandCollector({
        name: 'vitest --coverage',
        language: 'js',
        command: (out) => [
          ...exec(),
          'vitest',
          'run',
          '--coverage.enabled',
          '--coverage.reporter=lcov',
          `--coverage.reportsDirectory=${out}`,
        ],
      })
    case 'jest':
      return lcovCommandCollector({
        name: 'jest --coverage',
        language: 'js',
        command: (out) => [
          ...exec(),
          'jest',
          '--coverage',
          '--coverageReporters=lcov',
          `--coverageDirectory=${out}`,
        ],
      })
    case 'mocha':
      return lcovCommandCollector({
        name: 'c8 mocha',
        language: 'js',
        command: (out) => [...exec(), 'c8', '--reporter=lcov', `--reports-dir=${out}`, 'mocha'],
      })
    case 'node:test':
      return lcovCommandCollector({
        name: 'node --test --experimental-test-coverage',
        language: 'js',
        command: (out) => [
          'node',
          '--test',
          '--experimental-test-coverage',
          '--test-reporter=lcov',
          `--test-reporter-destination=${out}/lcov.info`,
        ],
      })
    case 'pytest':
      return lcovCommandCollector({
        name: 'pytest --cov',
        language: 'python',
        command: (out) => [
          'python3',
          '-m',
          'pytest',
          '--cov=.',
          `--cov-report=lcov:${out}/lcov.info`,
        ],
      })
    case 'go test':
      return goCoverageCollector()
    default:
      throw new Error(`no coverage collector for ${String(framework)}`)
  }
}

/**
 * Reads an existing coverage report instead of running tests: a Go cover profile (first line
 * `mode:`) or an lcov tracefile. `file` is absolute or relative to the project.
 */
export function coverageFileCollector(file: string): CoverageCollector {
  return {
    name: `coverage file ${file}`,
    async collect({ dir, runner, signal }) {
      const path = isAbsolute(file) ? file : join(dir, file)
      const text = await readFile(path, 'utf8')
      if (/^mode:\s*\w+/.test(text.trimStart())) {
        const modules = await goModules(dir)
        const report = parseGoCoverProfile(text, modules)
        const functions = modules.length ? await goFunctions(runner, dir, path, signal) : undefined
        return functions ? withGoFunctions(report, parseGoCoverFunc(functions, modules)) : report
      }
      const report = parseLcov(text, dir)
      return { ...report, languages: languagesOf(report.files) }
    },
  }
}

/** Combines reports from several collectors (e.g. Go and TypeScript in one repository). */
export function mergeReports(reports: readonly CoverageReport[]): CoverageReport {
  const [first] = reports
  if (reports.length === 1 && first) return first
  const sum = (
    pick: (report: CoverageReport) => { covered: number; total: number } | undefined,
  ) => {
    const parts = reports.map(pick).filter((part) => part !== undefined)
    if (!parts.length) return undefined
    return parts.reduce((acc, part) => ({
      covered: acc.covered + part.covered,
      total: acc.total + part.total,
    }))
  }
  const lines = sum((report) => report.summary.lines)
  const functions = sum((report) => report.summary.functions)
  return {
    format: first?.format ?? 'lcov',
    languages: [...new Set(reports.flatMap((report) => report.languages))],
    files: reports.flatMap((report) => report.files),
    summary: { ...(lines ? { lines } : {}), ...(functions ? { functions } : {}) },
  }
}

/**
 * How many commits touched each file (relative to `dir`) in the last `days` days, from
 * `git log`. Empty when `dir` is not in a git repository.
 */
export async function collectChurn({
  dir,
  runner,
  days = 90,
  signal,
}: CoverageContext & { days?: number }): Promise<Map<string, number>> {
  const churn = new Map<string, number>()
  let result
  try {
    result = await runner.run(
      [
        'git',
        'log',
        `--since=${days}.days`,
        '--name-only',
        '--relative',
        '--no-renames',
        '--pretty=format:',
        '--',
        '.',
      ],
      { cwd: dir, ...(signal ? { signal } : {}) },
    )
  } catch {
    return churn
  }
  if (result.exitCode !== 0) return churn
  for (const line of result.stdout.split('\n')) {
    const file = line.trim()
    if (file) churn.set(file, (churn.get(file) ?? 0) + 1)
  }
  return churn
}
