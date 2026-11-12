import { readdir, realpath } from 'node:fs/promises'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'

import {
  defaultAllow,
  defaultDeny,
  isDevOnly,
  type LicensedPackage,
  type LicenseException,
  type LicensePolicyData,
  type LicensesData,
} from './model.ts'
import { parseOsvLicenses, type ScannedPackage } from './parse.ts'
import { licenseEvaluator } from './spdx.ts'

/** Allow, deny and ignore lists; missing lists take the defaults (`ignore` defaults to none). */
export interface LicensePolicyOptions {
  allow?: readonly string[]
  deny?: readonly string[]
  /** Package names (`*` wildcards allowed) whose licenses are not judged. */
  ignore?: readonly string[]
  /** Licenses that need a sign-off even when `allow` matches them. Default none. */
  review?: readonly string[]
  /** `violation` judges packages with unknown licenses not allowed. Default `warn`. */
  unknown?: 'warn' | 'violation'
  /** `ignore` leaves out packages only dev dependency groups use. Default `check`. */
  devDependencies?: 'check' | 'ignore'
  /** Packages accepted although their license would not pass. Default none. */
  exceptions?: readonly LicenseException[]
  /** Warn when the repository itself has no license file. Default false. */
  requireProjectLicense?: boolean
}

/**
 * The policy with defaults applied. With `today` (`YYYY-MM-DD`), exceptions that expired before it
 * are left out.
 */
export function resolvePolicy(
  options: LicensePolicyOptions = {},
  today?: string,
): LicensePolicyData {
  const exceptions = (options.exceptions ?? []).filter(
    (exception) => !today || !exception.expires || exception.expires >= today,
  )
  return {
    allow: [...(options.allow ?? defaultAllow)],
    deny: [...(options.deny ?? defaultDeny)],
    ignore: [...(options.ignore ?? [])],
    ...(options.review?.length ? { review: [...options.review] } : {}),
    ...(options.unknown === 'violation' ? { unknown: 'violation' as const } : {}),
    ...(options.devDependencies === 'ignore' ? { devDependencies: 'ignore' as const } : {}),
    ...(exceptions.length ? { exceptions: exceptions.map((exception) => ({ ...exception })) } : {}),
    ...(options.requireProjectLicense ? { requireProjectLicense: true } : {}),
  }
}

const licenseFilePattern = /^(?:licen[cs]e|copying|unlicense)(?:[-._].*)?$/i

/** License files at the root of `dir`: `LICENSE`, `LICENSE.md`, `LICENSE-MIT`, `COPYING`, ... */
export async function projectLicenseFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .toSorted()
}

const namePattern = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  )

/**
 * The repository (`forge:path`) that defines a package, or `undefined` for third-party packages.
 * Packages it names are `internal` and not judged.
 */
export type InternalPackages = (ecosystem: string, name: string) => string | undefined

const sameLicense = (declared: readonly string[], wanted: string) => {
  const text = declared.join(' AND ').toLowerCase()
  return text === wanted.trim().toLowerCase()
}

/**
 * Whether the repository reaches a package only through dev dependencies, from a source other than
 * osv-scanner's dependency groups (the newest `depgraph` record).
 */
export type DevOnlyPackages = (ecosystem: string, name: string, version: string) => boolean

/**
 * Packages without dependency groups get `groups: ['dev']` when `devOnly` names them; the others
 * are returned unchanged.
 */
export function withDevFallback(
  packages: readonly ScannedPackage[],
  devOnly: DevOnlyPackages,
): ScannedPackage[] {
  return packages.map((pkg) =>
    !pkg.groups?.length && devOnly(pkg.ecosystem, pkg.name, pkg.version)
      ? { ...pkg, groups: ['dev'] }
      : pkg,
  )
}

/**
 * Judges every package against the policy: `ignore` first (and dev-only packages, see
 * `isDevOnly`, when `devDependencies` is `ignore`), then `internal`, then the licenses; a package
 * whose licenses do not pass becomes `excepted` when one of `policy.exceptions` matches its name,
 * version and declared licenses. Pure: the same packages, policy and internal packages give the same verdicts.
 */
export function evaluatePackages(
  packages: readonly ScannedPackage[],
  policy: LicensePolicyData,
  internal?: InternalPackages,
): LicensedPackage[] {
  const evaluate = licenseEvaluator(policy)
  const ignored = policy.ignore.map(namePattern)
  const exceptions = (policy.exceptions ?? []).map((exception) => ({
    exception,
    name: namePattern(exception.package),
  }))
  const exceptionFor = (pkg: ScannedPackage) =>
    exceptions.find(
      ({ exception, name }) =>
        name.test(pkg.name) &&
        (!exception.version || exception.version === pkg.version) &&
        (!exception.license || sameLicense(pkg.licenses, exception.license)),
    )?.exception
  return packages.map((pkg): LicensedPackage => {
    if (ignored.some((pattern) => pattern.test(pkg.name))) return { ...pkg, verdict: 'ignored' }
    if (policy.devDependencies === 'ignore' && isDevOnly(pkg.groups))
      return { ...pkg, verdict: 'ignored' }
    const definedIn = internal?.(pkg.ecosystem, pkg.name)
    if (definedIn !== undefined) return { ...pkg, verdict: 'internal', definedIn }
    const result = evaluate(pkg.licenses)
    const strict = result.verdict === 'unknown' && policy.unknown === 'violation'
    const verdict = strict ? 'unlisted' : result.verdict
    const culprits =
      strict && result.culprits.length === 0
        ? pkg.licenses.length > 0
          ? pkg.licenses
          : ['UNKNOWN']
        : result.culprits
    const exception = verdict === 'allowed' ? undefined : exceptionFor(pkg)
    if (exception)
      return {
        ...pkg,
        verdict: 'excepted',
        exception: exception.reason,
        ...(culprits.length > 0 ? { culprits } : {}),
      }
    return { ...pkg, verdict, ...(culprits.length > 0 ? { culprits } : {}) }
  })
}

export interface AnalyzeLicensesOptions {
  dir: string
  runner: CommandRunner
  policy?: LicensePolicyOptions
  /** Packages the analyzed repositories define; they are listed but not judged. */
  internal?: InternalPackages
  /** Dev-only packages for the ones osv-scanner reports without dependency groups. */
  devOnly?: DevOnlyPackages
  /** Path or name of the osv-scanner binary. */
  binary?: string
  /** Extra arguments for `osv-scanner scan source`. */
  args?: readonly string[]
  /** The day exceptions are checked against, `YYYY-MM-DD`. Default today (UTC). */
  today?: string
  signal?: AbortSignal
}

/** osv-scanner exits 1 when it found vulnerabilities; that is still a complete run. */
const VULNERABILITIES_FOUND = 1

async function versionOf(runner: CommandRunner, binary: string, cwd: string, signal?: AbortSignal) {
  try {
    const { stdout } = await runner.run([binary, '--version'], {
      cwd,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    })
    return /osv-scanner version:\s*(\S+)/.exec(stdout)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Lists every package of every lockfile and manifest in `dir` with its licenses, using
 * `osv-scanner scan source --all-packages --licenses` (license data comes from deps.dev, so the
 * scanner needs network access), and judges them against the policy.
 */
export async function analyzeLicenses({
  dir,
  runner,
  policy,
  internal,
  devOnly,
  binary = 'osv-scanner',
  args = [],
  today = new Date().toISOString().slice(0, 10),
  signal,
}: AnalyzeLicensesOptions): Promise<LicensesData> {
  // osv-scanner reports resolved paths; resolve too so sources come out relative to `dir`.
  const root = await realpath(dir)
  const options = { cwd: root, ...(signal ? { signal } : {}) }
  const version = await versionOf(runner, binary, root, signal)
  const { stdout } = await runChecked(
    runner,
    [
      binary,
      'scan',
      'source',
      '--recursive',
      '--allow-no-lockfiles',
      '--all-packages',
      '--licenses',
      '--format',
      'json',
      ...args,
      root,
    ],
    options,
    [0, VULNERABILITIES_FOUND],
  )
  const resolved = resolvePolicy(policy, today)
  const scanned = parseOsvLicenses(stdout.trim() ? JSON.parse(stdout) : {}, root)
  return {
    tool: { name: 'osv-scanner', ...(version ? { version } : {}) },
    policy: resolved,
    packages: evaluatePackages(
      devOnly ? withDevFallback(scanned, devOnly) : scanned,
      resolved,
      internal,
    ),
    project: { licenseFiles: await projectLicenseFiles(root) },
  }
}
