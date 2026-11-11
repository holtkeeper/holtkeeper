import { describe, expect, test } from 'bun:test'

import { detectFlow } from './detect.ts'
import { releaseSettings } from './settings.ts'
import { prependChangelog } from './steps.ts'

describe('settings', () => {
  test('default to off and parse an empty value', () => {
    const settings = releaseSettings()
    expect(settings.enabled).toBe(false)
    expect(settings.acceptance).toBe('none')
    expect(settings.gates.pipeline).toBe(true)
  })

  test('drop fields a stored row of an older shape breaks, keep the rest', () => {
    const settings = releaseSettings({
      enabled: true,
      flow: { mode: 'trunk' },
      version: { tagFormat: 'release-{version}', prerelease: 'rc', bump: { minimum: 'minor' } },
      acceptance: { required: true, signals: ['label'] },
      gates: { pipeline: 'success', freeze: [{ days: ['fri'] }], blockingLabels: ['hold'] },
      deploy: { environments: [{ name: 'prod', auto: true }, { job: 'nameless' }] },
      summary: { mode: 'agent' },
      timezone: 'Europe/Berlin',
    })
    expect(settings).toEqual({
      enabled: true,
      flow: { mode: 'trunk', source: 'development' },
      version: { scheme: 'semver', tagFormat: 'release-{version}', prerelease: false },
      acceptance: 'none',
      changelogFile: false,
      changelog: { excludeTypes: [] },
      mergeRequest: { labels: [] },
      deploy: { environments: [{ name: 'prod', confirm: true }] },
      gates: { pipeline: true, blockingLabels: ['hold'] },
    })
  })

  test('drop only the broken elements of a list', () => {
    const settings = releaseSettings({
      mergeRequest: { labels: [1, 'b', 2, 'd'] },
      deploy: { environments: [{ name: '' }, { name: 'b' }, { name: '' }, { name: 'd' }] },
    })
    expect(settings.mergeRequest.labels).toEqual(['b', 'd'])
    expect(settings.deploy.environments.map((environment) => environment.name)).toEqual(['b', 'd'])
  })

  test('survive values that are not objects', () => {
    expect(releaseSettings('nope').enabled).toBe(false)
    expect(releaseSettings({ flow: 'trunk' }).flow.mode).toBe('merge-request')
  })
})

describe('changelog file', () => {
  test('goes below the title', () => {
    expect(prependChangelog('# Changelog\n\n## 1.0.0\n\n- old\n', '## 1.1.0\n\n- new')).toBe(
      '# Changelog\n\n## 1.1.0\n\n- new\n\n## 1.0.0\n\n- old\n',
    )
    expect(prependChangelog('## 1.0.0\n', '## 1.1.0')).toBe('## 1.1.0\n\n## 1.0.0\n')
  })
})

describe('flow detection', () => {
  test('merge request flow from merges of a development branch', () => {
    const detected = detectFlow({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'development' }],
      tags: [{ name: 'v1.0.0' }, { name: 'v0.1.0' }],
      merged: [{ sourceBranch: 'development', targetBranch: 'main' }],
      files: ['package.json'],
    })
    expect(detected.mode).toBe('merge-request')
    expect(detected.settings).toEqual({
      flow: { mode: 'merge-request', source: 'development' },
      version: { scheme: 'semver', tagFormat: 'v{version}' },
    })
  })

  test('release target next to a development default branch', () => {
    const detected = detectFlow({
      defaultBranch: 'development',
      branches: [{ name: 'development' }, { name: 'main' }, { name: 'feature/ABC-1' }],
      tags: [{ name: 'v1.1.0' }, { name: 'v1.0.0' }],
      merged: [
        { sourceBranch: 'feature/ABC-1', targetBranch: 'development' },
        { sourceBranch: 'feature/ABC-2', targetBranch: 'development' },
        { sourceBranch: 'development', targetBranch: 'main' },
        { sourceBranch: 'development', targetBranch: 'main' },
        { sourceBranch: 'development', targetBranch: 'release/old' },
      ],
      files: [],
    })
    expect(detected.mode).toBe('merge-request')
    expect(detected.settings['flow']).toEqual({
      mode: 'merge-request',
      source: 'development',
      target: 'main',
    })
    expect(detected.reasons[0]).toBe('2 merge request(s) from development into main')
  })

  test('trunk with calendar tags, and external release tools', () => {
    expect(
      detectFlow({
        defaultBranch: 'main',
        branches: [{ name: 'main' }],
        tags: [{ name: '2026.10.1' }, { name: '2026.10.0' }],
        merged: [],
        files: [],
      }).settings,
    ).toEqual({ flow: { mode: 'trunk' }, version: { scheme: 'calver', tagFormat: '{version}' } })
    expect(
      detectFlow({
        defaultBranch: 'main',
        branches: [],
        tags: [{ name: '@scope/a@1.0.0' }],
        merged: [],
        files: ['.changeset'],
      }).mode,
    ).toBe('external')
  })
})
