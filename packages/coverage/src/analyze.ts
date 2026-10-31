import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'
import {
  codeLines,
  collectCoverage,
  coverageCollectors,
  type CoverageCollector,
  type FileCoverage,
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
 * Collects line, function and branch coverage of a checkout per source file: installs JavaScript
 * dependencies when they are missing, builds workspace packages whose entry files are missing, runs the tests of every detected framework with coverage
 * (or reads `file`), leaves out tests, configs, generated and excluded files, and adds source
 * files no test loaded as fully uncovered. Throws when no collector produced a report, naming a
 * failed install.
 */
export async function analyzeCoverage(options: AnalyzeCoverageOptions): Promise<CoverageData> {
  const { dir, runner, signal } = options
  const collectors =
    options.collectors ??
    (await coverageCollectors(dir, options.file ? { file: options.file } : 'run'))
  let install: InstallOutcome | undefined
  if (!options.file && (options.install ?? true) && collectors.length) {
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
  if (!options.file && (options.build ?? true) && collectors.length) {
    const build = await buildWorkspaces({ dir, runner, ...(signal ? { signal } : {}) })
    if (build.status === 'built') options.log?.(`workspaces: built ${build.workspaces.join(', ')}`)
    if (build.status === 'failed')
      options.log?.(
        `workspaces: build failed${build.workspaces.length ? ` after ${build.workspaces.join(', ')}` : ''}\n${build.error}`,
      )
  }
  let report
  try {
    report = await collectCoverage(collectors, { dir, runner, ...(signal ? { signal } : {}) })
  } catch (error) {
    if (install?.status !== 'failed') throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n${install.command.join(' ')} failed before: ${install.error}`, {
      cause: error,
    })
  }
  signal?.throwIfAborted()

  const excluded = (options.exclude ?? []).map((pattern) => new Bun.Glob(pattern))
  const keep = (file: string) =>
    !file.startsWith('/') &&
    !file.startsWith('../') &&
    !isTestFile(file) &&
    !isExcludedByName(file) &&
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
