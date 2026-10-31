import { describe, expect, test } from 'bun:test'

import type { ForgeAccess } from '@holtkeeper/analyzer'

import { renovateConfig, renovateEnv, renovatePlatform, repositoryConfig } from './config.ts'
import { renovateOptionsSchema, renovatePresets } from './options.ts'

const access: ForgeAccess = {
  kind: 'gitlab',
  url: 'https://gitlab.example.com/',
  token: 'glpat-secret',
  readOnly: false,
}

const options = (input: Record<string, unknown> = {}) => renovateOptionsSchema.parse(input)

const build = (input: Record<string, unknown> = {}, forge: ForgeAccess = access) =>
  renovateConfig({
    options: options(input),
    access: forge,
    repo: 'games/app',
    reportPath: '/work/report.json',
    baseDir: '/work/base',
  })

describe('renovatePlatform', () => {
  test('maps forges to platforms and API endpoints', () => {
    expect(renovatePlatform(access)).toEqual({
      platform: 'gitlab',
      endpoint: 'https://gitlab.example.com/api/v4/',
    })
    expect(renovatePlatform({ kind: 'github', url: 'https://github.com' }).endpoint).toBe(
      'https://api.github.com/',
    )
    expect(renovatePlatform({ kind: 'github', url: 'https://ghe.example.com' }).endpoint).toBe(
      'https://ghe.example.com/api/v3/',
    )
    expect(() => renovatePlatform({ kind: 'file', url: 'file:///repos' })).toThrow(/file forge/)
  })
})

describe('renovateConfig', () => {
  test('the default is a lookup-only run of one repository that writes a report', () => {
    const config = build()
    expect(config).toMatchObject({
      platform: 'gitlab',
      repositories: ['games/app'],
      onboarding: false,
      requireConfig: 'optional',
      dryRun: 'lookup',
      reportType: 'file',
      reportPath: '/work/report.json',
      baseDir: '/work/base',
      binarySource: 'global',
      allowScripts: false,
      extends: ['config:recommended'],
      minimumReleaseAge: '3 days',
      osvVulnerabilityAlerts: true,
      prConcurrentLimit: 10,
      prHourlyLimit: 2,
      labels: ['holtkeeper', 'dependencies'],
      branchPrefix: 'renovate/',
      packageRules: [],
    })
    expect(JSON.stringify(config)).not.toContain('glpat-secret')
  })

  test('merge-requests mode opens merge requests unless the repository is read-only', () => {
    expect(build({ mode: 'merge-requests' })).not.toHaveProperty('dryRun')
    expect(build({ mode: 'merge-requests' }, { ...access, readOnly: true })).toMatchObject({
      dryRun: 'lookup',
    })
  })

  test('signing sets the author and keeps commits local', () => {
    const config = build(
      { mode: 'merge-requests' },
      { ...access, signing: { privateKey: 'KEY', name: 'Holt Bot', email: 'bot@example.com' } },
    )
    expect(config).toMatchObject({
      gitAuthor: 'Holt Bot <bot@example.com>',
      platformCommit: 'disabled',
    })
    expect(JSON.stringify(config)).not.toContain('KEY')
  })

  test('raw config wins over fields, and its package rules come after ours', () => {
    const config = build({
      majors: false,
      config: {
        prHourlyLimit: 9,
        packageRules: [{ matchPackageNames: ['react'], automerge: true }],
      },
    })
    expect(config.prHourlyLimit).toBe(9)
    expect(config.packageRules).toEqual([
      { matchUpdateTypes: ['major'], enabled: false },
      { matchPackageNames: ['react'], automerge: true },
    ])
  })

  test('ignoring the repository config', () => {
    expect(build({ repoConfig: 'ignore' }).requireConfig).toBe('ignored')
  })
})

describe('repositoryConfig', () => {
  test('grouping adds Renovate group presets', () => {
    expect(repositoryConfig(options({ grouping: 'non-major' })).extends).toEqual([
      'config:recommended',
      'group:allNonMajor',
    ])
    expect(repositoryConfig(options({ grouping: 'all' })).extends).toEqual([
      'config:recommended',
      'group:all',
    ])
  })

  test('security only disables every package and keeps vulnerability alerts', () => {
    const config = repositoryConfig(options({ updates: 'security', vulnerabilityAlerts: false }))
    expect(config.packageRules).toEqual([{ matchPackageNames: ['*'], enabled: false }])
    expect(config.vulnerabilityAlerts).toEqual({ enabled: true })
    expect(config.osvVulnerabilityAlerts).toBe(true)
  })

  test('release age, ignored packages and lockfile maintenance', () => {
    const config = repositoryConfig(
      options({ releaseAgeDays: 1, ignore: ['@internal/*'], lockFileMaintenance: true }),
    )
    expect(config.minimumReleaseAge).toBe('1 day')
    expect(config.lockFileMaintenance).toEqual({ enabled: true })
    expect(config.packageRules).toEqual([{ matchPackageNames: ['@internal/*'], enabled: false }])
    expect(repositoryConfig(options({ releaseAgeDays: 0 }))).not.toHaveProperty('minimumReleaseAge')
  })

  test('every preset is a valid set of options', () => {
    for (const preset of renovatePresets)
      expect(() => renovateOptionsSchema.parse(preset.options)).not.toThrow()
  })
})

describe('renovateEnv', () => {
  test('passes the token and key, and removes Holtkeeper variables', () => {
    const env = renovateEnv({
      configFile: '/work/config.json',
      access: { ...access, signing: { privateKey: 'KEY', name: 'n', email: 'e' } },
      environment: { HOLTKEEPER_VAULT_KEY: 'x', PATH: '/bin' },
    })
    expect(env).toMatchObject({
      RENOVATE_CONFIG_FILE: '/work/config.json',
      RENOVATE_TOKEN: 'glpat-secret',
      RENOVATE_GIT_PRIVATE_KEY: 'KEY',
    })
    expect(env).toHaveProperty('HOLTKEEPER_VAULT_KEY', undefined)
    expect(env).not.toHaveProperty('PATH')
  })
})
