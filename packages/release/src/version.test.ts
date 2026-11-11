import { describe, expect, test } from 'bun:test'

import { releaseSettings } from './settings.ts'
import {
  bumpSemver,
  compareVersions,
  latestVersion,
  nextVersion,
  parsePackageTag,
  releaseTarget,
  tagName,
  versionOfTag,
  versionTags,
} from './version.ts'

const now = new Date('2026-11-01T10:00:00Z')

describe('tags', () => {
  test('reads versions through the tag format', () => {
    expect(versionOfTag('v{version}', 'v1.2.3')).toBe('1.2.3')
    expect(versionOfTag('release-{version}-final', 'release-2.0.0-final')).toBe('2.0.0')
    expect(versionOfTag('v{version}', '1.2.3')).toBeUndefined()
    expect(tagName('v{version}', '1.0.0')).toBe('v1.0.0')
  })

  test('keeps version tags newest first and skips other tags', () => {
    const settings = releaseSettings()
    const tags = versionTags(settings, [
      { name: 'v1.6.4', sha: 'a' },
      { name: 'v1.10.0', sha: 'b' },
      { name: '@scope/pkg@1.0.0', sha: 'c' },
      { name: 'v1.10.0-rc.1', sha: 'd' },
      { name: 'nightly', sha: 'e' },
    ])
    expect(tags.map((tag) => tag.tag)).toEqual(['v1.10.0', 'v1.10.0-rc.1', 'v1.6.4'])
    expect(latestVersion(settings, tags)?.tag).toBe('v1.10.0')
  })

  test('skips pre-releases as the latest version unless release candidates are on', () => {
    const tags = [
      { tag: 'v2.0.0-rc.1', version: '2.0.0-rc.1', sha: 'a' },
      { tag: 'v1.0.0', version: '1.0.0', sha: 'b' },
    ]
    expect(latestVersion(releaseSettings(), tags)?.version).toBe('1.0.0')
    expect(latestVersion(releaseSettings({ version: { prerelease: true } }), tags)?.version).toBe(
      '2.0.0-rc.1',
    )
  })
})

describe('next version', () => {
  test('bumps semantic versions', () => {
    expect(bumpSemver('1.2.3', 'major')).toBe('2.0.0')
    expect(bumpSemver('1.2.3', 'minor')).toBe('1.3.0')
    expect(bumpSemver('1.2.3', 'patch')).toBe('1.2.4')
    expect(bumpSemver('1.3.0-rc.2', 'patch')).toBe('1.3.0')
  })

  test('starts at the initial version and stops on none', () => {
    const settings = releaseSettings()
    expect(nextVersion(settings, undefined, 'minor', [], now)).toBe('0.1.0')
    expect(nextVersion(settings, '1.0.0', 'none', [], now)).toBeUndefined()
  })

  test('counts pre-releases of the same version', () => {
    const settings = releaseSettings({ version: { prerelease: true } })
    const tags = [
      { tag: 'v1.3.0-rc.1', version: '1.3.0-rc.1', sha: 'a' },
      { tag: 'v1.2.0', version: '1.2.0', sha: 'b' },
    ]
    expect(nextVersion(settings, '1.2.0', 'minor', [tags[1]!], now)).toBe('1.3.0-rc.1')
    expect(nextVersion(settings, '1.3.0-rc.1', 'patch', tags, now)).toBe('1.3.0-rc.2')
    expect(nextVersion(settings, '1.3.0-rc.1', 'major', tags, now)).toBe('2.0.0-rc.1')
  })

  test('follows the UTC calendar', () => {
    const settings = releaseSettings({ version: { scheme: 'calver' } })
    const late = new Date('2026-11-01T00:30:00Z')
    expect(nextVersion(settings, undefined, 'patch', [], late)).toBe('2026.11.0')
    expect(nextVersion(settings, '2026.11.0', 'patch', [], late)).toBe('2026.11.1')
    expect(nextVersion(settings, '2026.10.4', 'major', [], late)).toBe('2026.11.0')
  })

  test('continues zero-padded calendar months', () => {
    const settings = releaseSettings({ version: { scheme: 'calver' } })
    const march = new Date('2026-03-10T10:00:00Z')
    const tags = versionTags(settings, [
      { name: 'v2026.3.0', sha: 'a' },
      { name: 'v2026.03.4', sha: 'b' },
    ])
    expect(tags.map((tag) => tag.version)).toEqual(['2026.03.4', '2026.3.0'])
    expect(nextVersion(settings, '2026.03.4', 'patch', tags, march)).toBe('2026.3.5')
  })

  test('counts calendar release candidates up within the month', () => {
    const settings = releaseSettings({ version: { scheme: 'calver', prerelease: true } })
    const tags = versionTags(settings, [
      { name: 'v2026.11.0-rc.1', sha: 'a' },
      { name: 'v2026.11.0-rc.2', sha: 'b' },
      { name: 'v2026.10.3', sha: 'c' },
    ])
    expect(tags.map((tag) => tag.version)).toEqual([
      '2026.11.0-rc.2',
      '2026.11.0-rc.1',
      '2026.10.3',
    ])
    expect(nextVersion(settings, '2026.11.0-rc.2', 'patch', tags, now)).toBe('2026.11.0-rc.3')
    expect(nextVersion(settings, '2026.10.3', 'patch', tags, now)).toBe('2026.11.0-rc.3')
    expect(nextVersion(settings, '2026.10.3-rc.1', 'patch', [], now)).toBe('2026.11.0-rc.1')
  })
})

test('compareVersions follows semver precedence', () => {
  const sorted = ['1.0.0', 'v1.0.0-rc.10', '1.0.0-rc.2', '1.0.0-alpha', '0.9.9', '1.0.0-alpha.1']
  sorted.sort(compareVersions)
  expect(sorted).toEqual([
    '0.9.9',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-rc.2',
    'v1.0.0-rc.10',
    '1.0.0',
  ])
})

describe('parsePackageTag', () => {
  test('reads the tags monorepo release tools create', () => {
    expect(parsePackageTag('@acme/ui.libs.card@0.7.0')).toEqual({
      tag: '@acme/ui.libs.card@0.7.0',
      package: '@acme/ui.libs.card',
      version: '0.7.0',
    })
    expect(parsePackageTag('card@1.0.0-rc.1')?.package).toBe('card')
    expect(parsePackageTag('tools/lint/v0.3.1')?.package).toBe('tools/lint')
    expect(parsePackageTag('api-client-v2.1.0')).toMatchObject({
      package: 'api-client',
      version: 'v2.1.0',
    })
  })

  test('plain versions and other tags are not package tags', () => {
    for (const tag of ['v1.2.3', '1.2.3', 'v1.2.3-rc-1', 'release-1.2.3', '@scope/card', 'latest'])
      expect(parsePackageTag(tag)).toBeUndefined()
  })
})

test('releaseTarget is the commit for package tags and the tag otherwise', () => {
  expect(releaseTarget({ name: '@scope/card@1.0.0', sha: 'abc' })).toBe('abc')
  expect(releaseTarget({ name: 'v1.0.0', sha: 'abc' })).toBe('v1.0.0')
})
