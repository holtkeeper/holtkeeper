import { describe, expect, test } from 'bun:test'

import {
  compareGoVersions,
  latestNodeMajor,
  nodeMajorFor,
  nodeVersion,
  pythonMinorFor,
  pythonRange,
  sdkmanJava,
} from './versions.ts'

describe('nodeVersion', () => {
  test.each([
    ['v20', '20'],
    ['20.11.1', '20.11.1'],
    ['v18.17.0\n', '18.17.0'],
    ['lts/*', 'lts'],
    ['lts/iron', '20'],
    ['lts/unknown', 'lts'],
    ['node', 'latest'],
    ['stable', 'latest'],
    ['>=18 <21', '20'],
    ['', undefined],
    ['banana', undefined],
  ])('%p → %p', (raw, expected) => {
    expect(nodeVersion(raw)).toBe(expected)
  })
})

describe('nodeMajorFor', () => {
  test('takes the newest even major inside the range', () => {
    expect(nodeMajorFor('>=18 <23')).toBe('22')
    expect(nodeMajorFor('^18.17.0')).toBe('18')
    expect(nodeMajorFor('^20 || ^22')).toBe('22')
    expect(nodeMajorFor('>=20.10')).toBe(String(latestNodeMajor))
  })

  test('falls back to odd majors and reports nothing for invalid ranges', () => {
    expect(nodeMajorFor('>=21.5 <22')).toBe('21')
    expect(nodeMajorFor('20.x')).toBe('20')
    expect(nodeMajorFor('garbage')).toBeUndefined()
    expect(nodeMajorFor('>=99')).toBeUndefined()
  })
})

describe('python', () => {
  test('converts PEP 440 specifiers', () => {
    expect(pythonRange('>=3.10,<3.13')).toBe('>=3.10 <3.13')
    expect(pythonRange('~=3.11')).toBe('>=3.11 <4')
    expect(pythonRange('~=3.11.2')).toBe('>=3.11.2 <3.12')
    expect(pythonRange('==3.11.*')).toBe('3.11.x')
    expect(pythonRange('>=3.9, !=3.9.1')).toBe('>=3.9')
  })

  test('picks the newest known minor', () => {
    expect(pythonMinorFor('>=3.10,<3.13')).toBe('3.12')
    expect(pythonMinorFor('~=3.11.2')).toBe('3.11')
    expect(pythonMinorFor('^3.9')).toBe('3.14')
    expect(pythonMinorFor('==3.11.*')).toBe('3.11')
    expect(pythonMinorFor('<3')).toBeUndefined()
  })
})

test('sdkmanJava maps vendor suffixes', () => {
  expect(sdkmanJava('21.0.2-tem')).toBe('temurin-21.0.2')
  expect(sdkmanJava('17.0.9-amzn')).toBe('corretto-17.0.9')
  expect(sdkmanJava('21.0.1-graalce')).toBe('graalvm-community-21.0.1')
  expect(sdkmanJava('11.0.2-weird')).toBe('11.0.2')
  expect(sdkmanJava('17')).toBe('17')
})

describe('compareGoVersions', () => {
  test.each([
    ['1.26.0', '1.25.0', 1],
    ['1.9', '1.10', -1],
    ['1.22', '1.22.0', 0],
    ['1.23rc1', '1.23.0', -1],
    ['1.23rc1', '1.23rc2', -1],
    ['banana', '1.0', -1],
  ])('%p vs %p → %p', (a, b, expected) => {
    expect(Math.sign(compareGoVersions(a, b))).toBe(expected)
  })
})
