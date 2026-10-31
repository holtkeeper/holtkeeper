import { describe, expect, test } from 'bun:test'

import { versionMatrix } from './matrix.ts'
import { compareSemver, inRange, parseSemver } from './semver.ts'
import type { LibraryUse, PublishedLibrary } from './types.ts'

const settings = { maxVersions: 8, firstOfMajor: false }

const published = (versions: string[], latest?: string): PublishedLibrary => ({
  ecosystem: 'npm',
  name: 'lib',
  versions: versions.map((version) => ({ version })),
  ...(latest ? { latest } : {}),
})

const uses = (...entries: [string, string][]): LibraryUse[] =>
  entries.map(([version, repo]) => ({ ecosystem: 'npm', name: 'lib', version, repo }))

const summary = (matrix: ReturnType<typeof versionMatrix>) =>
  Object.fromEntries(matrix.map((item) => [item.version, item.roles.join(',')]))

describe('semver', () => {
  test('orders prereleases, Go prefixes and build metadata', () => {
    const sorted = [
      '1.0.0',
      '1.0.0-rc.10',
      'v1.0.1',
      '1.0.0-alpha',
      '1.0.0-rc.2',
      '1.0.0-alpha.1',
      '1.0.0-beta',
      'v2.0.0+incompatible',
    ].toSorted(compareSemver)
    expect(sorted).toEqual([
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-beta',
      '1.0.0-rc.2',
      '1.0.0-rc.10',
      '1.0.0',
      'v1.0.1',
      'v2.0.0+incompatible',
    ])
    expect(parseSemver('not a version')).toBeUndefined()
    expect(compareSemver('garbage', '0.0.1')).toBeLessThan(0)
  })

  test('ranges are open below and closed above', () => {
    expect(inRange('1.0.0', '1.0.0', '2.0.0')).toBe(false)
    expect(inRange('2.0.0', '1.0.0', '2.0.0')).toBe(true)
    expect(inRange('v1.5.0', '1.0.0')).toBe(true)
  })
})

describe('versionMatrix', () => {
  test('the react example of the design', () => {
    const react = published(
      [
        '17.0.2',
        '18.0.0',
        '18.1.0',
        '18.2.0',
        '18.3.0',
        '18.3.1',
        '19.0.0-rc.1',
        '19.0.0',
        '19.0.1',
        '19.1.0',
        '19.2.0',
        '19.2.1',
        '20.0.0-canary.1',
      ],
      '19.2.1',
    )
    const matrix = versionMatrix(
      uses(['18.2.0', 'gl:a'], ['18.3.1', 'gl:b'], ['19.0.0', 'gl:c'], ['18.3.1', 'gl:a']),
      react,
      settings,
    )
    expect(summary(matrix)).toEqual({
      '19.2.1': 'latest,minor',
      '19.0.1': 'patch',
      '19.0.0': 'used',
      '18.3.1': 'used,minor,patch',
      '18.2.0': 'used,patch',
    })
    expect(matrix.map((item) => item.version)).toEqual([
      '19.2.1',
      '19.0.1',
      '19.0.0',
      '18.3.1',
      '18.2.0',
    ])
    expect(matrix.find((item) => item.version === '18.3.1')?.usedBy).toEqual(['gl:a', 'gl:b'])
  })

  test('crossed majors get their newest release and optionally the first', () => {
    const lib = published(
      ['16.0.0', '16.1.0', '17.0.0', '17.0.2', '18.0.0', '18.1.0', '19.0.0', '19.1.0'],
      '19.1.0',
    )
    const matrix = versionMatrix(uses(['16.0.0', 'gl:a']), lib, { ...settings, firstOfMajor: true })
    expect(summary(matrix)).toEqual({
      '19.1.0': 'latest,major',
      '19.0.0': 'first',
      '18.1.0': 'major',
      '18.0.0': 'first',
      '17.0.2': 'major',
      '17.0.0': 'first',
      '16.1.0': 'minor',
      '16.0.0': 'used,patch',
    })
  })

  test('prereleases count only when used, and latest prefers a stable dist-tag', () => {
    const lib = published(['1.0.0', '1.1.0', '2.0.0-beta.1', '2.0.0-beta.2'], '2.0.0-beta.2')
    expect(summary(versionMatrix(uses(['1.0.0', 'gl:a']), lib, settings))).toEqual({
      '1.1.0': 'latest,minor',
      '1.0.0': 'used,patch',
    })
    expect(summary(versionMatrix(uses(['2.0.0-beta.1', 'gl:a']), lib, settings))).toEqual({
      '2.0.0-beta.1': 'used',
      '1.1.0': 'latest',
    })
  })

  test('a latest tag below the newest release caps the matrix', () => {
    const lib = published(['1.0.0', '1.2.0', '2.0.0', '3.0.0'], '2.0.0')
    expect(summary(versionMatrix(uses(['1.0.0', 'gl:a']), lib, settings))).toEqual({
      '2.0.0': 'latest,major',
      '1.2.0': 'minor',
      '1.0.0': 'used,patch',
    })
  })

  test('Go versions keep their v prefix and match uses without it', () => {
    const lib = published(['v1.0.0', 'v1.0.1', 'v2.0.0'])
    const matrix = versionMatrix(uses(['1.0.0', 'gl:a']), lib, settings)
    expect(summary(matrix)).toEqual({
      'v2.0.0': 'latest,major',
      'v1.0.1': 'minor,patch',
      'v1.0.0': 'used',
    })
  })

  test('used versions unknown to the registry stay', () => {
    expect(summary(versionMatrix(uses(['0.0.0-local', 'gl:a']), undefined, settings))).toEqual({
      '0.0.0-local': 'used',
    })
  })

  test('without uses only latest is indexed', () => {
    expect(summary(versionMatrix([], published(['1.0.0', '2.0.0']), settings))).toEqual({
      '2.0.0': 'latest',
    })
  })

  test('maxVersions drops low-priority roles first and keeps every used version', () => {
    const lib = published(
      ['1.0.0', '1.0.5', '1.4.0', '2.0.0', '2.3.0', '3.0.0', '3.1.0', '4.0.0', '4.2.0'],
      '4.2.0',
    )
    const options = { maxVersions: 4, firstOfMajor: true }
    expect(summary(versionMatrix(uses(['1.0.0', 'gl:a']), lib, options))).toEqual({
      '4.2.0': 'latest,major',
      '1.4.0': 'minor',
      '1.0.5': 'patch',
      '1.0.0': 'used',
    })
    expect(
      summary(
        versionMatrix(uses(['1.0.0', 'gl:a'], ['2.0.0', 'gl:b'], ['3.0.0', 'gl:c']), lib, {
          maxVersions: 2,
          firstOfMajor: true,
        }),
      ),
    ).toEqual({ '3.0.0': 'used,patch', '2.0.0': 'used,patch', '1.0.0': 'used' })
  })

  test('within one role newer versions win', () => {
    const lib = published(['1.0.0', '1.1.0', '2.0.0', '2.1.0', '3.0.0'], '3.0.0')
    const matrix = versionMatrix(uses(['1.0.0', 'gl:a'], ['2.0.0', 'gl:b']), lib, {
      maxVersions: 4,
      firstOfMajor: false,
    })
    expect(summary(matrix)).toEqual({
      '3.0.0': 'latest,major',
      '2.1.0': 'minor',
      '2.0.0': 'used,patch',
      '1.0.0': 'used,patch',
    })
  })
})
