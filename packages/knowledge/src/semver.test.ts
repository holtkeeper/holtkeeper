import { describe, expect, test } from 'bun:test'

import {
  coerceVersion,
  compatibleRange,
  describePackage,
  packageOverlaps,
  packagesOverlap,
} from './semver.ts'

const react = { ecosystem: 'npm', name: 'react', from: '>=18 <19', to: '>=19 <20' }

describe('versions', () => {
  test('coerces loose versions', () => {
    expect(coerceVersion('^18.2')).toBe('18.2.0')
    expect(coerceVersion('v19')).toBe('19.0.0')
    expect(coerceVersion('1.2.3-rc.1')).toBe('1.2.3-rc.1')
    expect(coerceVersion('latest')).toBeUndefined()
  })

  test('compatible ranges follow semver majors, minors below 1.0', () => {
    expect(compatibleRange('18.3.1')).toBe('>=18 <19')
    expect(compatibleRange('~19.0.0')).toBe('>=19 <20')
    expect(compatibleRange('0.14.2')).toBe('>=0.14 <0.15')
    expect(compatibleRange('next')).toBeUndefined()
  })
})

describe('packageOverlaps', () => {
  test('matches when a task version falls into an entry range', () => {
    expect(
      packageOverlaps(react, { ecosystem: 'npm', name: 'react', from: '18.3.1', to: '19.0.0' }),
    ).toBeTrue()
    expect(
      packageOverlaps(react, { ecosystem: 'npm', name: 'react', from: '19.0.0', to: '19.1.0' }),
    ).toBeTrue()
    expect(
      packageOverlaps(react, { ecosystem: 'npm', name: 'react', from: '17.0.2', to: '^18.2.0' }),
    ).toBeTrue()
    expect(
      packageOverlaps(react, { ecosystem: 'npm', name: 'react', from: '16.0.0', to: '17.0.2' }),
    ).toBeFalse()
    expect(packageOverlaps(react, { ecosystem: 'npm', name: 'react', from: '20.0.0' })).toBeFalse()
  })

  test('needs the same package; missing versions or ranges match by name', () => {
    expect(
      packageOverlaps(react, { ecosystem: 'npm', name: 'react-dom', from: '18.0.0' }),
    ).toBeFalse()
    expect(packageOverlaps(react, { ecosystem: 'go', name: 'react', from: '18.0.0' })).toBeFalse()
    expect(packageOverlaps(react, { ecosystem: 'NPM', name: 'React' })).toBeTrue()
    expect(
      packageOverlaps(
        { ecosystem: 'npm', name: 'react' },
        { ecosystem: 'npm', name: 'react', from: '1.0.0' },
      ),
    ).toBeTrue()
    expect(packagesOverlap([react], [])).toBeFalse()
  })

  test('describes packages compactly', () => {
    expect(describePackage(react)).toBe('react >=18 <19 → >=19 <20')
    expect(describePackage({ ecosystem: 'npm', name: 'vue', to: '>=3' })).toBe('vue to >=3')
    expect(describePackage({ ecosystem: 'npm', name: 'vue' })).toBe('vue')
  })
})
