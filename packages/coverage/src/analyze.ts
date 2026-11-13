import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'
import {
  codeLines,
  collectCoverage,
  type CollectorOptions,
  coverageCollectors,
  type CoverageCollector,
  type CoverageReport,
  type FileCoverage,
  isComponentFile,
  isExcludedByName,
  isGeneratedSource,
  isTestFile,
  isTypeOnlySource,
  languageOf,
  listFiles,
} from '@holtkeeper/quality-tests'

import { buildWorkspaces } from './build.ts'
import { type InstallOutcome, installDependencies } from './install.ts'
import { type CoverageData, type FileCoverageData, sumCounts } from './model.ts'

export interface AnalyzeCoverageOptions {
  dir: string
  runner: CommandRunner
  /** An lcov tracefile or Go cover profile in the checkout to read instead of running tests. */
  file?: string
  /** Collectors to use instead of the ones derived from `file` and the detected frameworks. */
  collectors?: readonly CoverageCollector[]
  /** Glob patterns (relative to `dir`) of files to leave out. */
  exclude?: readonly string[]
  /** Count source files no test loaded as uncovered. Default true. */
  untested?: boolean
  /** Count component files (`.tsx`, `.jsx`) too. Default false: components need no tests. */
  components?: boolean
  /**
   * Install JavaScript dependencies from the lockfile before running tests, when `node_modules` is
   * missing. Default true; never applies when `file` is given.
   */
  install?: boolean
  /** Let that install run lifecycle scripts. Default false. */
  installScripts?: boolean
  /**
   * Run the `build` script of workspace packages whose entry files are missing before the tests.
   * Default true; never applies when `file` is given.
   */
  build?: boolean
  /** Settings of the Go collector: `go test` timeout and the tags of a second, tagged run. */
  go?: CollectorOptions['go']
  log?: (line: string) => void
  signal?: AbortSignal
}

function fileCounts(file: FileCoverage): FileCoverageData {
  const lines = { covered: file.lines.filter((l) => l.hits > 0).length, total: file.lines.length }
  const functions = file.functions.length
    ? { covered: file.functions.filter((fn) => fn.hits > 0).length, total: file.functions.length }
    : undefined
  const branches = file.branches.length
    ? {
        covered: file.branches.filter((b) => (b.taken ?? 0) > 0).length,
        total: file.branches.length,
      }
    : undefined
  return {
    file: file.file,
    lines,
    ...(functions ? { functions } : {}),
    ...(branches ? { branches } : {}),
  }
}

const NOT_RUN_REASONS: Record<string, string> = {
  'build failed': 'did not build',
  'setup failed': 'dependencies did not load',
  'timed out': 'tests timed out',
}

function notRunReason(file: string, notRun: CoverageReport['notRun']): string | undefined {
  if (!notRun?.length || languageOf(file) !== 'go') return undefined
  const folder = dirname(file) === '.' ? '' : dirname(file)
  const within = (dir: string) => dir === '' || folder === dir || folder.startsWith(`${dir}/`)
  const entry = notRun.find((item) =>
    item.recursive
      ? within(item.dir) && !item.except?.some((dir) => dir !== '' && within(dir))
      : folder === item.dir,
  )
  return entry ? (NOT_RUN_REASONS[entry.reason] ?? entry.reason) : undefined
}

/** Code lines of source files the report does not mention, in the report's languages. */
async function untestedFiles(
  dir: string,
  languages: readonly string[],
  known: ReadonlySet<string>,
  keep: (file: string) => boolean,
): Promise<FileCoverageData[]> {
  const found: FileCoverageData[] = []
  for (const file of await listFiles(dir)) {
    const language = languageOf(file)
    if (!language || !languages.includes(language) || known.has(file) || !keep(file)) continue
    let text
    try {
      // oxlint-disable-next-line no-await-in-loop
      text = await readFile(join(dir, file), 'utf8')
    } catch {
      continue
    }
    if (isGeneratedSource(text) || (language === 'js' && isTypeOnlySource(text))) continue
    const total = codeLines(text, language, 1, text.split('\n').length)
    if (total > 0) found.push({ file, lines: { covered: 0, total }, loaded: false })
  }
  return found
}

/**
 * Collects line, function and branch coverage of a checkout per source file: when the checkout has
 * a `package.json`, installs JavaScript dependencies when they are missing and builds workspace
 * packages whose entry files are missing; then runs the tests of every detected framework with
 * coverage (or reads `file`), leaves out tests, configs, generated and excluded files and, unless
 * `components`, component files, and adds source files no test loaded as fully uncovered. Files
 * of Go packages whose tests could not run carry `reason`. Throws when no collector produced a report; after a
 * failed install the error starts with that failure, then the collectors' errors.
 */
export async function analyzeCoverage(options: AnalyzeCoverageOptions): Promise<CoverageData> {
  const { dir, runner, signal } = options
  const collectors =
    options.collectors ??
    (await coverageCollectors(
      dir,
      options.file ? { file: options.file } : 'run',
      options.go ? { go: options.go } : {},
    ))
  const javascript = existsSync(join(dir, 'package.json'))
  let install: InstallOutcome | undefined
  if (!options.file && javascript && (options.install ?? true) && collectors.length) {
    install = await installDependencies({
      dir,
      runner,
      scripts: options.installScripts ?? false,
      ...(signal ? { signal } : {}),
    })
    options.log?.(
      install.status === 'skipped'
        ? `dependencies: not installed (${install.reason})`
        : `dependencies: ${install.command.join(' ')} ${install.status === 'installed' ? 'ok' : `failed\n${install.error}`}`,
    )
  }
  if (!options.file && javascript && (options.build ?? true) && collectors.length) {
    const build = await buildWorkspaces({ dir, runner, ...(signal ? { signal } : {}) })
    if (build.status === 'built') options.log?.(`workspaces: built ${build.workspaces.join(', ')}`)
    if (build.status === 'failed')
      options.log?.(
        `workspaces: build failed${build.workspaces.length ? ` after ${build.workspaces.join(', ')}` : ''}\n${build.error}`,
      )
  }
  let report
  try {
    report = await collectCoverage(collectors, {
      dir,
      runner,
      ...(signal ? { signal } : {}),
      ...(options.log ? { log: options.log } : {}),
    })
  } catch (error) {
    if (install?.status !== 'failed') throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `installing dependencies failed (${install.command.join(' ')}): ${install.error}\nso no tests could run:\n${message}`,
      { cause: error },
    )
  }
  signal?.throwIfAborted()

  const excluded = (options.exclude ?? []).map((pattern) => new Bun.Glob(pattern))
  const keep = (file: string) =>
    !file.startsWith('/') &&
    !file.startsWith('../') &&
    !isTestFile(file) &&
    !isExcludedByName(file) &&
    (options.components || !isComponentFile(file)) &&
    !excluded.some((glob) => glob.match(file))

  const byFile = new Map<string, FileCoverageData>()
  for (const file of report.files) {
    if (!keep(file.file)) continue
    const counts = fileCounts(file)
    const seen = byFile.get(file.file)
    if (!seen || seen.lines.total < counts.lines.total) byFile.set(file.file, counts)
  }
  const files = [...byFile.values()]
  if (options.untested ?? true)
    files.push(...(await untestedFiles(dir, report.languages, new Set(byFile.keys()), keep)))
  files.sort((a, b) => a.file.localeCompare(b.file))
  for (const [index, file] of files.entries()) {
    const reason = file.lines.covered ? undefined : notRunReason(file.file, report.notRun)
    if (reason) files[index] = { ...file, reason }
  }

  const lines = sumCounts(files.map((file) => file.lines)) ?? { covered: 0, total: 0 }
  const functions = sumCounts(files.map((file) => file.functions))
  const branches = sumCounts(files.map((file) => file.branches))
  const summary: CoverageData['summary'] = {
    lines,
    ...(functions ? { functions } : {}),
    ...(branches ? { branches } : {}),
  }
  return { tools: report.tools, languages: report.languages, summary, files }
}
