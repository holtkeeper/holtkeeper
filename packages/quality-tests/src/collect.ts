import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

import { CommandError, type CommandRunner } from '@holtkeeper/exec'
import { discoverGoModules } from '@holtkeeper/go-source'

import { listFiles } from './files.ts'
import {
  type GoModule,
  goPackageDir,
  parseGoCoverFunc,
  parseGoCoverProfile,
  withGoFunctions,
} from './gocover.ts'
import { goTaggedTests } from './gotags.ts'
import { type GoTestOutcome, parseGoTestEvents } from './gotest.ts'
import { languagesOf, parseLcov } from './lcov.ts'
import type {
  CoverageCollector,
  CoverageContext,
  CoverageReport,
  FunctionHit,
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

/** The report under `out`, or the same folder below a tool's own root (jest `rootDir`). */
async function findReport(dir: string, out: string, file: string): Promise<string | undefined> {
  const expected = join(dir, out, file)
  if (existsSync(expected)) return expected
  const glob = new Bun.Glob(`**/${basename(out)}/${file}`)
  for await (const path of glob.scan({ cwd: dir, dot: true })) return join(dir, path)
  return undefined
}

/**
 * Runs the project's tests with lcov coverage and parses the report. Failing tests do not fail
 * collection as long as the report was written, also when the tool resolved the relative report
 * folder against its own root; a missing report throws `CommandError`.
 */
export function lcovCommandCollector(spec: LcovCommand): CoverageCollector {
  return {
    name: spec.name,
    async collect({ dir, runner, signal }: CoverageContext) {
      const out = await scratchDir(dir)
      let stray: string | undefined
      try {
        const command = spec.command(out.rel)
        const result = await runner.run(command, {
          cwd: dir,
          timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        })
        const report = await findReport(dir, out.rel, spec.reportFile ?? 'lcov.info')
        if (report && dirname(report) !== out.abs) stray = dirname(report)
        let text: string
        try {
          if (!report) throw new Error('no report')
          text = await readFile(report, 'utf8')
        } catch {
          throw new CommandError(command, result)
        }
        return withLanguages(parseLcov(text, dir), [spec.language])
      } finally {
        await rm(out.abs, { recursive: true, force: true })
        if (stray) await rm(stray, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Runs a package binary: from `node_modules/.bin` when the project has one (yarn berry only finds
 * binaries the root workspace declares), else through the package manager.
 */
function packageExec(dir: string, command: readonly string[]): string[] {
  if (existsSync(join(dir, 'node_modules', '.bin')))
    return ['sh', '-c', 'PATH="$PWD/node_modules/.bin:$PATH" exec "$@"', 'sh', ...command]
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return ['pnpm', 'exec', ...command]
  if (existsSync(join(dir, 'yarn.lock'))) return ['yarn', ...command]
  return ['npx', '--no-install', ...command]
}

/**
 * Environment of every per-module `go` command: never download a toolchain, resolve modules even
 * when `go.sum` is out of date. A run over a `go.work` keeps only `GOTOOLCHAIN`, because Go refuses
 * `-mod=mod` in workspace mode.
 */
export const goTestEnv: Readonly<Record<string, string>> = {
  GOTOOLCHAIN: 'local',
  GOFLAGS: '-mod=mod',
}

/** The repository's Go modules as `@holtkeeper/go-source` discovers them, with `''` for the root. */
async function goModules(dir: string): Promise<{ workspace: boolean; modules: GoModule[] }> {
  const found = await discoverGoModules(dir).catch(() => ({ workspace: false, modules: [] }))
  return {
    workspace: found.workspace,
    modules: found.modules.map((module) => ({
      path: module.module,
      dir: module.dir === '.' ? '' : module.dir,
    })),
  }
}

async function goFunctions(
  runner: CommandRunner,
  cwd: string,
  profile: string,
  env: Record<string, string>,
  signal?: AbortSignal,
) {
  try {
    const result = await runner.run(['go', 'tool', 'cover', `-func=${profile}`], {
      cwd,
      env,
      ...(signal ? { signal } : {}),
    })
    return result.exitCode === 0 ? result.stdout : undefined
  } catch {
    return undefined
  }
}

const listed = (packages: readonly string[]) =>
  packages.length > 5
    ? `${packages.slice(0, 5).join(', ')} and ${packages.length - 5} more`
    : packages.join(', ')

const firstLines = (text: string, count = 3) =>
  text
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, count)
    .join(' | ')

/** Options of `goCoverageCollector`. */
export interface GoCoverageOptions {
  /** Go's `-timeout` for each test binary. Default `5m`. */
  testTimeout?: string
  /** Build tags of a second run whose coverage is added to the untagged run's. None by default. */
  tags?: readonly string[]
  /** Kills one `go test` command after this many milliseconds. Default 15 minutes. */
  timeoutMs?: number
}

function nestedModules(module: GoModule, modules: readonly GoModule[]): string[] {
  return modules
    .filter(
      (other) =>
        other !== module &&
        other.dir !== module.dir &&
        (module.dir === '' || other.dir.startsWith(`${module.dir}/`)),
    )
    .map((other) => other.dir)
}

interface GoRun {
  cwd: string
  label: string
  patterns: string[]
  env: Record<string, string>
  modules: GoModule[]
}

function goRuns(dir: string, workspace: boolean, modules: readonly GoModule[]): GoRun[] {
  if (workspace)
    return [
      {
        cwd: dir,
        label: 'go test',
        patterns: modules.map((module) => (module.dir ? `./${module.dir}/...` : './...')),
        env: { GOTOOLCHAIN: goTestEnv.GOTOOLCHAIN ?? 'local' },
        modules: [...modules],
      },
    ]
  return modules.map((module) => ({
    cwd: join(dir, module.dir),
    label: modules.length > 1 ? `go test (${module.dir || '.'})` : 'go test',
    patterns: ['./...'],
    env: { ...goTestEnv, GOWORK: 'off' },
    modules: [module],
  }))
}

interface GoTestRun {
  outcome: GoTestOutcome
  profile?: string
  error?: CommandError
  /** Go's own error output when no package ran. */
  detail?: string
}

async function goTest(
  runner: CommandRunner,
  run: GoRun,
  profile: string,
  tags: readonly string[],
  options: GoCoverageOptions,
  signal?: AbortSignal,
): Promise<GoTestRun> {
  const command = [
    'go',
    'test',
    '-json',
    `-timeout=${options.testTimeout ?? '5m'}`,
    `-coverprofile=${relative(run.cwd, profile)}`,
    ...(tags.length ? [`-tags=${tags.join(',')}`] : []),
    ...run.patterns,
  ]
  const result = await runner.run(command, {
    cwd: run.cwd,
    env: run.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
  const outcome = parseGoTestEvents(result.stdout)
  const text = await readFile(profile, 'utf8').catch(() => undefined)
  if (text !== undefined && (result.exitCode === 0 || outcome.ran.length))
    return { outcome, profile: text }
  const stderr = [result.stderr.trim(), outcome.buildOutput.trim()].filter(Boolean).join('\n')
  return { outcome, error: new CommandError(command, { ...result, stderr }), detail: stderr }
}

function logOutcome(label: string, outcome: GoTestOutcome, log?: (line: string) => void) {
  if (outcome.notRun.length)
    log?.(
      `${label}: tests of ${outcome.notRun.length} package(s) did not run: ${listed(outcome.notRun.map((p) => `${p.pkg} (${p.reason}${p.error ? `: ${p.error}` : ''})`))}`,
    )
  if (outcome.failed.length)
    log?.(
      `${label}: tests failed in ${outcome.failed.length} package(s): ${listed(outcome.failed)}`,
    )
}

async function logTaggedTests(dir: string, tags: readonly string[], log?: (line: string) => void) {
  if (!log) return
  const files = await Promise.all(
    (await listFiles(dir))
      .filter((file) => file.endsWith('_test.go'))
      .map(async (file) => ({
        file,
        source: await readFile(join(dir, file), 'utf8').catch(() => ''),
      })),
  )
  const tagged = goTaggedTests(files, tags)
  if (!tagged.files) return
  log(
    `go test: ${tagged.files} test file(s) need build tags this run does not set and were not compiled: ${tagged.tags.map((t) => `${t.tag} (${t.files})`).join(', ')}; the coverage option goTags runs them`,
  )
}

const withoutMode = (profile: string) =>
  profile
    .split('\n')
    .filter((line) => !line.startsWith('mode:'))
    .join('\n')

/**
 * Runs `go test -json -coverprofile` per Go module (or once over a `go.work`), with
 * `GOTOOLCHAIN=local`, `GOFLAGS=-mod=mod` (not over a `go.work`) and `-timeout`, and names functions with
 * `go tool cover -func`. Go writes a zero-count profile even when no package's tests could run, so
 * a module in which no package ran counts as failed: the collector throws `CommandError` with Go's
 * output when every module failed, and otherwise reports the failed modules in `notRun`. Packages
 * that did not build, could not load their dependencies or timed out go to `notRun` and `log`, as
 * do failing tests and test files left out by build tags. With `tags`, a second run with
 * `-tags` adds its coverage; its failures are only logged.
 */
export function goCoverageCollector(options: GoCoverageOptions = {}): CoverageCollector {
  const tags = options.tags ?? []
  return {
    name: 'go test -coverprofile',
    async collect({ dir, runner, signal, log }) {
      const { workspace, modules } = await goModules(dir)
      if (!modules.length) throw new Error('no go.mod or go.work found')
      await logTaggedTests(dir, tags, log)
      const out = await scratchDir(dir)
      try {
        const runs = goRuns(dir, workspace, modules)
        const profiles: string[] = []
        const functions = new Map<string, FunctionHit[]>()
        const notRun: NonNullable<CoverageReport['notRun']> = []
        const errors: CommandError[] = []
        for (const [index, run] of runs.entries()) {
          // Sequential: every run is a whole test suite in the same checkout.
          // oxlint-disable-next-line no-await-in-loop
          const plain = await goTest(
            runner,
            run,
            join(out.abs, `cover-${index}.out`),
            [],
            options,
            signal,
          )
          if (plain.profile === undefined) {
            if (plain.error) errors.push(plain.error)
            if (runs.length > 1)
              log?.(`${run.label}: no tests ran: ${firstLines(plain.detail ?? '')}`)
            const reason = plain.outcome.notRun[0]?.reason ?? 'setup failed'
            for (const module of run.modules) {
              const except = nestedModules(module, modules)
              notRun.push({
                dir: module.dir,
                reason,
                recursive: true,
                ...(except.length ? { except } : {}),
              })
            }
            continue
          }
          logOutcome(run.label, plain.outcome, log)
          let text = plain.profile
          let ranTagged = new Set<string>()
          if (tags.length) {
            const label = `${run.label} -tags=${tags.join(',')}`
            // oxlint-disable-next-line no-await-in-loop
            const tagged = await goTest(
              runner,
              run,
              join(out.abs, `cover-${index}-tags.out`),
              tags,
              options,
              signal,
            )
            if (tagged.profile === undefined) {
              log?.(`${label}: no tests ran: ${firstLines(tagged.detail ?? '')}`)
            } else {
              logOutcome(label, tagged.outcome, log)
              text = `${text.trimEnd()}\n${withoutMode(tagged.profile)}`
              ranTagged = new Set(tagged.outcome.ran)
            }
          }
          for (const entry of plain.outcome.notRun) {
            const packageDir = ranTagged.has(entry.pkg)
              ? undefined
              : goPackageDir(entry.pkg, modules)
            if (packageDir !== undefined) notRun.push({ dir: packageDir, reason: entry.reason })
          }
          profiles.push(text)
          const combined = join(out.abs, `cover-${index}.all.out`)
          // oxlint-disable-next-line no-await-in-loop
          await writeFile(combined, text)
          // oxlint-disable-next-line no-await-in-loop
          const listing = await goFunctions(
            runner,
            run.cwd,
            relative(run.cwd, combined),
            run.env,
            signal,
          )
          if (listing)
            for (const [file, list] of parseGoCoverFunc(listing, modules)) functions.set(file, list)
        }
        if (!profiles.length) {
          const [first] = errors
          if (first && errors.length === 1) throw first
          throw new Error(
            errors.map((error) => error.message).join('\n') || 'go test produced no coverage',
          )
        }
        const parsed = parseGoCoverProfile(profiles.join('\n'), modules)
        const report = functions.size ? withGoFunctions(parsed, functions) : parsed
        return notRun.length ? { ...report, notRun } : report
      } finally {
        await rm(out.abs, { recursive: true, force: true })
      }
    },
  }
}

/** Collector settings per language; only Go has any. */
export interface CollectorOptions {
  go?: GoCoverageOptions
}

/** The collector that runs `framework`'s tests with coverage in the project. */
export function collectorFor(
  framework: TestFramework,
  dir: string,
  options: CollectorOptions = {},
): CoverageCollector {
  const exec = (...command: string[]) => packageExec(dir, command)
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
        command: (out) =>
          exec(
            'vitest',
            'run',
            '--coverage.enabled',
            '--coverage.reporter=lcov',
            `--coverage.reportsDirectory=${out}`,
          ),
      })
    case 'jest':
      return lcovCommandCollector({
        name: 'jest --coverage',
        language: 'js',
        command: (out) =>
          exec('jest', '--coverage', '--coverageReporters=lcov', `--coverageDirectory=${out}`),
      })
    case 'mocha':
      return lcovCommandCollector({
        name: 'c8 mocha',
        language: 'js',
        command: (out) => exec('c8', '--reporter=lcov', `--reports-dir=${out}`, 'mocha'),
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
      return goCoverageCollector(options.go)
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
        const { modules } = await goModules(dir)
        const report = parseGoCoverProfile(text, modules)
        const functions = modules.length
          ? await goFunctions(runner, dir, path, { ...goTestEnv }, signal)
          : undefined
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
  const notRun = reports.flatMap((report) => report.notRun ?? [])
  return {
    format: first?.format ?? 'lcov',
    languages: [...new Set(reports.flatMap((report) => report.languages))],
    files: reports.flatMap((report) => report.files),
    summary: { ...(lines ? { lines } : {}), ...(functions ? { functions } : {}) },
    ...(notRun.length ? { notRun } : {}),
  }
}
