import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { parseRenovateReport } from './parse.ts'

const fixture = () => Bun.file(join(import.meta.dir, '../test/report.json')).text()

describe('parseRenovateReport', () => {
  test('reads dependencies, updates, deprecations, branches and libyears', async () => {
    const parsed = parseRenovateReport(await fixture(), 'games/app')
    expect(parsed.dependencies).toBe(4)
    expect(parsed.outdated).toBe(3)
    expect(parsed.libYears).toBe(3.456)
    expect(parsed.managers).toEqual([
      { manager: 'npm', files: 1, dependencies: 3 },
      { manager: 'dockerfile', files: 1, dependencies: 1 },
    ])
    expect(parsed.updates).toEqual([
      {
        dependency: 'react',
        manager: 'npm',
        file: 'package.json',
        depType: 'dependencies',
        current: '18.3.1',
        next: '19.2.0',
        type: 'major',
        vulnerability: false,
        pending: false,
        url: 'https://github.com/facebook/react',
        mergeRequest: 12,
      },
      {
        dependency: 'lodash',
        manager: 'npm',
        file: 'package.json',
        depType: 'dependencies',
        current: '4.17.20',
        next: '4.17.21',
        type: 'patch',
        vulnerability: true,
        pending: false,
        releasedAt: '2021-02-20T15:42:16.891Z',
      },
      {
        dependency: 'node',
        manager: 'dockerfile',
        file: 'Dockerfile',
        current: '22-slim',
        next: '24-slim',
        type: 'major',
        vulnerability: false,
        pending: true,
      },
    ])
    expect(parsed.deprecated).toEqual([
      {
        dependency: 'request',
        manager: 'npm',
        file: 'package.json',
        message: 'request has been deprecated',
        abandoned: false,
      },
    ])
    expect(parsed.branches).toEqual([
      {
        branch: 'renovate/react-monorepo',
        mergeRequest: 12,
        title: 'Update react monorepo to v19',
        result: 'done',
        types: ['major'],
        updates: 2,
      },
      {
        branch: 'renovate/lock-file-maintenance',
        title: 'Lock file maintenance',
        result: 'pr-limit-reached',
        types: ['lockFileMaintenance'],
        updates: 1,
      },
    ])
  })

  test('keeps warnings and errors, global ones too', async () => {
    expect(parseRenovateReport(await fixture(), 'games/app').problems).toEqual([
      { level: 'warning', message: 'Found renovate config warnings' },
      { level: 'error', message: 'Failed to look up npm package left-pad' },
    ])
  })

  test('matches the repository case-insensitively and copes with a missing one', async () => {
    expect(parseRenovateReport(await fixture(), 'Games/App').dependencies).toBe(4)
    const other = parseRenovateReport(await fixture(), 'games/other')
    expect(other).toMatchObject({ dependencies: 0, updates: [], branches: [] })
    expect(other.problems).toHaveLength(1)
  })

  test('rejects text that is not a report', () => {
    expect(() => parseRenovateReport('not json', 'games/app')).toThrow()
    expect(() => parseRenovateReport('{"repositories": []}', 'games/app')).toThrow()
  })
})
