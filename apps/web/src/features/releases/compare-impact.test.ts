import { describe, expect, test } from 'bun:test'

import type { PackageDiff, UpgradeFinding } from '@holtkeeper/api'

import {
  apiBreaks,
  apiCounts,
  checkAction,
  checkActive,
  fileLocation,
  findingGroups,
  missingText,
  packageQuery,
  skippedLines,
  underBumped,
} from './compare-impact.ts'

const diff = (patch: Partial<PackageDiff> = {}): PackageDiff => ({
  name: 'widget-kit',
  added: 0,
  removed: 0,
  changed: 0,
  breaking: 0,
  deprecated: 0,
  required: 'none',
  changes: [],
  ...patch,
})

const finding = (id: string, severity: UpgradeFinding['severity']): UpgradeFinding => ({
  id,
  severity,
  category: 'behavior',
  title: id,
  detail: '',
  files: [],
  check: '',
})

describe('apiCounts', () => {
  test('lists non-zero kinds, breaking kinds first', () => {
    expect(apiCounts(diff({ added: 3, removed: 2, deprecated: 1 }))).toBe(
      '2 removed, 1 deprecated, 3 added',
    )
    expect(apiCounts(diff())).toBe('')
  })
})

describe('apiBreaks', () => {
  test('is true when the changes call for a major bump', () => {
    expect(apiBreaks(diff({ removed: 1, required: 'major' }))).toBe(true)
    expect(apiBreaks(diff({ changed: 2, added: 1, required: 'minor' }))).toBe(false)
  })
})

describe('underBumped', () => {
  test('compares the version bump with what the changes call for', () => {
    expect(underBumped(diff({ required: 'major', bumped: 'minor' }))).toBe(true)
    expect(underBumped(diff({ required: 'minor', bumped: 'major' }))).toBe(false)
    expect(underBumped(diff({ required: 'major' }))).toBe(false)
  })
})

describe('missingText', () => {
  test('groups names by the end they lack a record at', () => {
    expect(
      missingText([
        { name: 'some-lib', side: 'both' },
        { name: 'widget-kit', side: 'from' },
        { name: 'other-lib', side: 'both' },
      ]),
    ).toBe('widget-kit at the start; some-lib, other-lib at either end')
    expect(missingText([])).toBe('')
  })
})

describe('packageQuery', () => {
  test('maps the root ecosystem and keeps resolved versions only', () => {
    expect(
      packageQuery(
        { ecosystem: 'npm' },
        {
          name: 'some-lib',
          change: 'updated',
          from: { range: '^1.0.0', version: '1.2.0' },
          to: { range: '^2.0.0' },
        },
      ),
    ).toEqual({ package: 'some-lib', ecosystem: 'npm', from: '1.2.0' })
    expect(
      packageQuery(
        { ecosystem: 'go' },
        { name: 'example.com/foo', change: 'added', to: { version: 'v1.4.0' } },
      ),
    ).toEqual({ package: 'example.com/foo', ecosystem: 'Go', to: 'v1.4.0' })
  })

  test('skips removed packages', () => {
    expect(
      packageQuery({ ecosystem: 'npm' }, { name: 'old-helper', change: 'removed' }),
    ).toBeUndefined()
  })
})

describe('findingGroups', () => {
  test('orders severities and drops empty groups', () => {
    const groups = findingGroups([
      finding('a', 'info'),
      finding('b', 'breaking'),
      finding('c', 'info'),
    ])
    expect(groups.map((g) => [g.severity, g.findings.map((f) => f.id)])).toEqual([
      ['breaking', ['b']],
      ['info', ['a', 'c']],
    ])
  })
})

describe('fileLocation', () => {
  test('adds the line when known', () => {
    expect(fileLocation({ path: 'src/foo.ts', line: 12 })).toBe('src/foo.ts:12')
    expect(fileLocation({ path: 'src/foo.ts' })).toBe('src/foo.ts')
  })
})

describe('check state', () => {
  test('is active while queued or running', () => {
    expect(checkActive({ status: 'queued' })).toBe(true)
    expect(checkActive({ status: 'running' })).toBe(true)
    expect(checkActive({ status: 'done' })).toBe(false)
    expect(checkActive(undefined)).toBe(false)
  })

  test('offers a first run, a forced run or nothing', () => {
    expect(checkAction({ status: 'none' })).toBe('start')
    expect(checkAction({ status: 'failed' })).toBe('start')
    expect(checkAction({ status: 'running' })).toBeUndefined()
    expect(checkAction(undefined)).toBeUndefined()
    const data = {
      from: { ref: 'v1.0.0', sha: 'a1' },
      to: { ref: 'v1.1.0', sha: 'b2' },
      verdict: 'safe' as const,
      summary: '',
      areas: [],
      findings: [],
      skipped: [],
      capped: false,
    }
    expect(checkAction({ status: 'done', data })).toBe('again')
    expect(checkAction({ status: 'failed', data })).toBe('again')
  })
})

describe('skippedLines', () => {
  test('words each reason with its file count', () => {
    expect(
      skippedLines([
        { files: 1, reason: 'binary' },
        { files: 0, reason: 'empty' },
        { files: 12, reason: 'lockfile or generated' },
      ]),
    ).toEqual(['1 file: binary', '12 files: lockfile or generated'])
  })
})
