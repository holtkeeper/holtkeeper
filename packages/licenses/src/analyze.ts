import { readdir, realpath } from 'node:fs/promises'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'

import {
  defaultAllow,
  defaultDeny,
  type LicensedPackage,
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
  /** `violation` judges packages with unknown licenses not allowed. Default `warn`. */
  unknown?: 'warn' | 'violation'
  /** Warn when the repository itself has no license file. Default false. */
  requireProjectLicense?: boolean
}

/** The policy with defaults applied. */
export function resolvePolicy(options: LicensePolicyOptions = {}): LicensePolicyData {
  return {
    allow: [...(options.allow ?? defaultAllow)],
    deny: [...(options.deny ?? defaultDeny)],
    ignore: [...(options.ignore ?? [])],
    ...(options.unknown === 'violation' ? { unknown: 'violation' as const } : {}),
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

/** Judges every package against the policy. Pure: the same packages and policy give the same verdicts. */
export function evaluatePackages(
  packages: readonly ScannedPackage[],
  policy: LicensePolicyData,
): LicensedPackage[] {
  const evaluate = licenseEvaluator(policy)
  const ignored = policy.ignore.map(namePattern)
  return packages.map((pkg) => {
    if (ignored.some((pattern) => pattern.test(pkg.name))) return { ...pkg, verdict: 'ignored' }
    const result = evaluate(pkg.licenses)
    const strict = result.verdict === 'unknown' && policy.unknown === 'violation'
    const verdict = strict ? 'unlisted' : result.verdict
    const culprits =
      strict && result.culprits.length === 0
        ? pkg.licenses.length > 0
          ? pkg.licenses
          : ['UNKNOWN']
        : result.culprits
    return { ...pkg, verdict, ...(culprits.length > 0 ? { culprits } : {}) }
  })
}

export interface AnalyzeLicensesOptions {
  dir: string
  runner: CommandRunner
  policy?: LicensePolicyOptions
  /** Path or name of the osv-scanner binary. */
  binary?: string
  /** Extra arguments for `osv-scanner scan source`. */
  args?: readonly string[]
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
  binary = 'osv-scanner',
  args = [],
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
  const resolved = resolvePolicy(policy)
  return {
    tool: { name: 'osv-scanner', ...(version ? { version } : {}) },
    policy: resolved,
    packages: evaluatePackages(
      parseOsvLicenses(stdout.trim() ? JSON.parse(stdout) : {}, root),
      resolved,
    ),
    project: { licenseFiles: await projectLicenseFiles(root) },
  }
}
