import { describe, expect, test } from 'bun:test'

import { parsePackageTag, releaseTarget } from './tags.ts'

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
