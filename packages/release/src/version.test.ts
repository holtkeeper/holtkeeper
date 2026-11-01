import { describe, expect, test } from 'bun:test'

import { releaseSettings } from './settings.ts'
import {
  bumpSemver,
  latestVersion,
  nextVersion,
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

  test('skips pre-releases as the latest version unless a channel is set', () => {
    const tags = [
      { tag: 'v2.0.0-rc.1', version: '2.0.0-rc.1', sha: 'a' },
      { tag: 'v1.0.0', version: '1.0.0', sha: 'b' },
    ]
    expect(latestVersion(releaseSettings(), tags)?.version).toBe('1.0.0')
    expect(latestVersion(releaseSettings({ version: { prerelease: 'rc' } }), tags)?.version).toBe(
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
    const settings = releaseSettings({ version: { prerelease: 'rc' } })
    const tags = [
      { tag: 'v1.3.0-rc.1', version: '1.3.0-rc.1', sha: 'a' },
      { tag: 'v1.2.0', version: '1.2.0', sha: 'b' },
    ]
    expect(nextVersion(settings, '1.2.0', 'minor', [tags[1]!], now)).toBe('1.3.0-rc.1')
    expect(nextVersion(settings, '1.3.0-rc.1', 'patch', tags, now)).toBe('1.3.0-rc.2')
    expect(nextVersion(settings, '1.3.0-rc.1', 'major', tags, now)).toBe('2.0.0-rc.1')
  })

  test('follows the calendar in the settings time zone', () => {
    const settings = releaseSettings({ version: { scheme: 'calver' }, timezone: 'Asia/Tokyo' })
    const late = new Date('2026-10-31T20:00:00Z')
    expect(nextVersion(settings, undefined, 'patch', [], late)).toBe('2026.11.0')
    expect(nextVersion(settings, '2026.11.0', 'patch', [], late)).toBe('2026.11.1')
    expect(nextVersion(settings, '2026.10.4', 'major', [], late)).toBe('2026.11.0')
  })
})
