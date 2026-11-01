import { describe, expect, test } from 'bun:test'

import { detectFlow } from './detect.ts'
import { activeFreeze } from './gates.ts'
import { releaseSettings } from './settings.ts'
import { prependChangelog } from './steps.ts'
import { fillTemplate } from './template.ts'

describe('freeze windows', () => {
  const settings = releaseSettings({
    timezone: 'Europe/Berlin',
    gates: {
      freeze: [
        { days: ['fri'], from: '15:00', reason: 'weekend' },
        { from: '22:00', to: '06:00' },
      ],
    },
  })

  test('match by weekday and local time, also across midnight', () => {
    expect(activeFreeze(settings, new Date('2026-10-30T14:30:00Z'))?.reason).toBe('weekend')
    expect(activeFreeze(settings, new Date('2026-10-30T12:00:00Z'))).toBeUndefined()
    expect(activeFreeze(settings, new Date('2026-10-28T03:00:00Z'))).toBeDefined()
    expect(activeFreeze(settings, new Date('2026-10-28T10:00:00Z'))).toBeUndefined()
  })
})

describe('templates', () => {
  test('fill values and dates, keep unknown placeholders', () => {
    const now = new Date('2026-11-01T23:30:00Z')
    expect(
      fillTemplate(
        'Release candidate {date} {date:DD.MM.YYYY} {version} {nope}',
        { version: '1.0.0' },
        now,
        'Europe/Moscow',
      ),
    ).toBe('Release candidate 2026-11-02 02.11.2026 1.0.0 {nope}')
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
    expect(detected.preset).toBe('merge-request-deferred-version')
    expect(detected.settings).toEqual({
      flow: { mode: 'merge-request', source: 'development' },
      version: { scheme: 'semver', tagFormat: 'v{version}' },
    })
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
      }).preset,
    ).toBe('external')
  })
})
