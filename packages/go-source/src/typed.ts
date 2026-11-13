import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CommandRunner } from '@holtkeeper/exec'

/** A field or method the Go type checker tied to a type declared in another module. */
export interface GoTypedSite {
  /** Relative to the checkout, `/`-separated. */
  file: string
  /** 1-based line and UTF-16 column of the member name. */
  line: number
  column: number
  /** Import path of the package declaring `export`. */
  importPath: string
  /** The exported type: the one declaring the member, or the exported type embedding it. */
  export: string
  member: string
  kind: 'call' | 'member'
}

/** One `go list` run of the helper: a module, or a `go.work` with the patterns of its members. */
export interface GoTypedRun {
  /** Directory to run in, relative to the checkout (`.` for the root). */
  dir: string
  /** `go.work` file relative to the checkout; absent runs the module alone with `GOWORK=off`. */
  gowork?: string
  /** Package patterns relative to `dir`; default `./...`. */
  patterns?: readonly string[]
}

/** What `goTypedUsages` did. */
export interface GoTypedOutcome {
  status: 'used' | 'skipped' | 'failed'
  reason?: string
  sites: GoTypedSite[]
  /** Packages type-checked over all runs. */
  packages: number
  /** Type errors, `go list` package errors and failed runs, capped. */
  errors: string[]
  /** The site cap was reached. */
  truncated?: boolean
}

/** Defaults of `goTypedUsages`. */
export const goTypedDefaults = {
  timeoutMs: 5 * 60_000,
  maxSites: 100_000,
  maxOutputBytes: 64 * 1024 * 1024,
}

const helperSource = fileURLToPath(new URL('../helper/typedusages/', import.meta.url))
const helperFiles = ['go.mod', 'main.go']
const compileSlackMs = 60_000

const goEnv = { GOTOOLCHAIN: 'local', GOWORK: 'off' }

const lastLines = (text: string) => text.trim().split('\n').slice(-5).join('\n')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSite = (value: unknown): value is GoTypedSite => {
  if (!isRecord(value)) return false
  const site = value
  return (
    typeof site.file === 'string' &&
    typeof site.line === 'number' &&
    typeof site.column === 'number' &&
    typeof site.importPath === 'string' &&
    typeof site.export === 'string' &&
    typeof site.member === 'string' &&
    (site.kind === 'call' || site.kind === 'member')
  )
}

interface HelperOutput {
  packages: number
  sites: GoTypedSite[]
  truncated: boolean
  errors: string[]
}

function parseOutput(stdout: string): HelperOutput {
  const record: unknown = JSON.parse(stdout)
  if (!isRecord(record)) throw new Error('unexpected helper output')
  const sites = Array.isArray(record.sites) ? record.sites.filter(isSite) : []
  return {
    packages: typeof record.packages === 'number' ? record.packages : 0,
    sites,
    truncated: record.truncated === true,
    errors: Array.isArray(record.errors)
      ? record.errors.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

/**
 * Asks the Go type checker which fields and methods the code of the given runs reaches through
 * values: `c := pkg.New(); c.Do()` gives export `Client` (the type of `c`) and member `Do`. Chains
 * rooted at a package name (`pkg.V.X`), which `scanGoUsages` reads, are left out, as are types of
 * the standard library and of the run's own modules. The helper is Go source shipped with this
 * package; it is copied into a hidden folder of the checkout, run with `go run` through `runner`
 * (so it works where the job's Go lives) and removed afterwards. It builds export data with
 * `go list -export -deps -test` under the job's `GOFLAGS`, adding `-mod=mod` for single modules that
 * set no `-mod`, so dependencies download through the job's proxy settings. Never throws for a
 * missing `go`, a failed run or type errors: it reports `skipped` without Go and `failed` when no
 * run succeeded, keeping the sites of the runs that did. Bounded by `timeoutMs` over all runs and
 * `maxSites`.
 */
export async function goTypedUsages(options: {
  dir: string
  runner: CommandRunner
  runs: readonly GoTypedRun[]
  timeoutMs?: number
  maxSites?: number
  signal?: AbortSignal
  log?: (line: string) => void
}): Promise<GoTypedOutcome> {
  const { dir, runner, runs, signal, log } = options
  const timeoutMs = options.timeoutMs ?? goTypedDefaults.timeoutMs
  const maxSites = options.maxSites ?? goTypedDefaults.maxSites
  const outcome = (
    status: GoTypedOutcome['status'],
    reason?: string,
    rest: Partial<GoTypedOutcome> = {},
  ): GoTypedOutcome => ({
    status,
    ...(reason ? { reason } : {}),
    sites: [],
    packages: 0,
    errors: [],
    ...rest,
  })
  if (!runs.length) return outcome('skipped', 'no Go module')

  try {
    const version = await runner.run(['go', 'version'], {
      cwd: dir,
      env: goEnv,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    })
    if (version.exitCode !== 0)
      return outcome(
        'skipped',
        `go is not available: ${lastLines(version.stderr || version.stdout)}`,
      )
  } catch (error) {
    return outcome(
      'skipped',
      `go is not available: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const deadline = Date.now() + timeoutMs
  let helper: string | undefined
  const sites: GoTypedSite[] = []
  const errors: string[] = []
  let packages = 0
  let truncated = false
  let succeeded = 0
  try {
    helper = await mkdtemp(join(dir, '.holtkeeper-typedusages-'))
    for (const file of helperFiles)
      // oxlint-disable-next-line no-await-in-loop -- two small files
      await copyFile(join(helperSource, file), join(helper, file))
    const back = (path: string) => posix.normalize(relative(helper ?? dir, join(dir, path)))

    for (const run of runs) {
      signal?.throwIfAborted()
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        errors.push(`${run.dir}: time limit reached`)
        break
      }
      if (sites.length >= maxSites) {
        truncated = true
        break
      }
      const command = [
        'go',
        'run',
        '.',
        '-root',
        back('.'),
        '-C',
        back(run.dir),
        '-gowork',
        run.gowork ? back(run.gowork) : 'off',
        '-max',
        String(maxSites - sites.length),
        '-timeout',
        `${remaining}ms`,
        ...(run.patterns ?? []),
      ]
      // oxlint-disable-next-line no-await-in-loop -- runs share the build cache and the time budget
      const result = await runner.run(command, {
        cwd: helper,
        env: goEnv,
        timeoutMs: remaining + compileSlackMs,
        ...(signal ? { signal } : {}),
      })
      if (result.exitCode !== 0) {
        errors.push(`${run.dir}: ${lastLines(result.stderr || result.stdout)}`)
        log?.(`usages: Go type checker failed in ${run.dir}: ${lastLines(result.stderr)}`)
        continue
      }
      if (result.stdout.length > goTypedDefaults.maxOutputBytes) {
        errors.push(`${run.dir}: helper output too large`)
        continue
      }
      let parsed: HelperOutput
      try {
        parsed = parseOutput(result.stdout)
      } catch (error) {
        errors.push(`${run.dir}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      succeeded += 1
      packages += parsed.packages
      sites.push(...parsed.sites.slice(0, maxSites - sites.length))
      if (parsed.truncated) truncated = true
      errors.push(...parsed.errors.map((message) => `${run.dir}: ${message}`))
    }
  } catch (error) {
    if (signal?.aborted) throw error
    errors.push(error instanceof Error ? error.message : String(error))
  } finally {
    if (helper) await rm(helper, { recursive: true, force: true })
  }

  const rest = {
    sites,
    packages,
    errors: errors.slice(0, 50),
    ...(truncated ? { truncated } : {}),
  }
  if (!succeeded) return outcome('failed', errors[0] ?? 'no run succeeded', rest)
  return outcome('used', undefined, rest)
}
