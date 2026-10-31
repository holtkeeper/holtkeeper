import type { ForgeAccess } from '@holtkeeper/analyzer'

import type { RenovateOptions } from './options.ts'

/** Renovate configuration as JSON: global options and repository defaults in one object. */
export type RenovateConfig = Record<string, unknown>

/** Renovate's `platform` and `endpoint` for a forge; throws for forges Renovate cannot drive. */
export function renovatePlatform(access: Pick<ForgeAccess, 'kind' | 'url'>): {
  platform: 'gitlab' | 'github'
  endpoint: string
} {
  const base = access.url.replace(/\/+$/, '')
  if (access.kind === 'gitlab') return { platform: 'gitlab', endpoint: `${base}/api/v4/` }
  if (access.kind === 'github')
    return {
      platform: 'github',
      endpoint: /^https?:\/\/(www\.)?github\.com$/.test(base)
        ? 'https://api.github.com/'
        : `${base}/api/v3/`,
    }
  throw new Error(`Renovate cannot run on a ${access.kind} forge`)
}

/** Whether a run opens merge requests: only in `merge-requests` mode and never on read-only repositories. */
export const opensMergeRequests = (
  options: RenovateOptions,
  access: Pick<ForgeAccess, 'readOnly'>,
) => options.mode === 'merge-requests' && !access.readOnly

/** Repository options that follow from the analyzer options, before the raw `config` is merged. */
export function repositoryConfig(
  options: RenovateOptions,
): RenovateConfig & { packageRules: unknown[] } {
  const extendsList = [
    ...options.presets,
    ...(options.grouping === 'non-major' ? ['group:allNonMajor'] : []),
    ...(options.grouping === 'all' ? ['group:all'] : []),
  ]
  const security = options.updates === 'security'
  const alerts = security || options.vulnerabilityAlerts
  const packageRules: unknown[] = [
    ...(security ? [{ matchPackageNames: ['*'], enabled: false }] : []),
    ...(!options.majors ? [{ matchUpdateTypes: ['major'], enabled: false }] : []),
    ...(options.ignore.length ? [{ matchPackageNames: options.ignore, enabled: false }] : []),
  ]
  return {
    extends: [...new Set(extendsList)],
    rangeStrategy: options.rangeStrategy,
    ...(options.releaseAgeDays > 0 && {
      minimumReleaseAge: `${options.releaseAgeDays} day${options.releaseAgeDays === 1 ? '' : 's'}`,
    }),
    osvVulnerabilityAlerts: alerts,
    vulnerabilityAlerts: { enabled: alerts },
    lockFileMaintenance: { enabled: options.lockFileMaintenance },
    prConcurrentLimit: options.concurrentLimit,
    prHourlyLimit: options.hourlyLimit,
    draftPR: options.draft,
    labels: options.labels,
    branchPrefix: options.branchPrefix,
    dependencyDashboard: options.dependencyDashboard,
    packageRules,
  }
}

/**
 * The config file one run reads: global options that point Renovate at one repository of the
 * forge, write a report to `reportPath` and keep every clone under `baseDir`, then the repository
 * options. A run that may not open merge requests is a lookup-only dry run. The token and the
 * signing key are not part of it: `renovateEnv` passes them.
 */
export function renovateConfig(input: {
  options: RenovateOptions
  access: ForgeAccess
  repo: string
  reportPath: string
  baseDir: string
}): RenovateConfig {
  const { options, access } = input
  const raw = input.options.config
  const repository = repositoryConfig(options)
  const rawRules = Array.isArray(raw.packageRules) ? raw.packageRules : []
  return {
    ...renovatePlatform(access),
    repositories: [input.repo],
    onboarding: false,
    requireConfig: options.repoConfig === 'merge' ? 'optional' : 'ignored',
    ...(!opensMergeRequests(options, access) && { dryRun: 'lookup' }),
    reportType: 'file',
    reportPath: input.reportPath,
    baseDir: input.baseDir,
    binarySource: 'global',
    allowScripts: false,
    persistRepoData: false,
    githubTokenWarn: false,
    ...(access.signing && {
      gitAuthor: `${access.signing.name} <${access.signing.email}>`,
      platformCommit: 'disabled',
    }),
    ...repository,
    ...raw,
    packageRules: [...repository.packageRules, ...rawRules],
  }
}

/**
 * Environment of a Renovate run: the config file, the token and signing key, plain logs, and
 * every `HOLTKEEPER_*` variable of the worker removed so server secrets never reach Renovate.
 */
export function renovateEnv(input: {
  configFile: string
  access: ForgeAccess
  environment?: Record<string, string | undefined>
}): Record<string, string | undefined> {
  const scrubbed = Object.fromEntries(
    Object.keys(input.environment ?? process.env)
      .filter((name) => name.startsWith('HOLTKEEPER_'))
      .map((name) => [name, undefined]),
  )
  return {
    ...scrubbed,
    RENOVATE_CONFIG_FILE: input.configFile,
    RENOVATE_TOKEN: input.access.token,
    ...(input.access.signing && { RENOVATE_GIT_PRIVATE_KEY: input.access.signing.privateKey }),
    LOG_LEVEL: 'info',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
  }
}
