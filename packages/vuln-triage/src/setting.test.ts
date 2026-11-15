import { describe, expect, test } from 'bun:test'

import { securityAlertsDefinition, securityAlertsSettings } from './setting.ts'

describe('securityAlertsSettings', () => {
  test('defaults report nothing and triage critical and unknown advisories', () => {
    expect(securityAlertsSettings(undefined)).toEqual({
      channels: [],
      severities: ['critical', 'unknown'],
      windowMinutes: 30,
    })
    expect(securityAlertsDefinition.default).toEqual(securityAlertsSettings({}))
  })

  test('keeps a valid value and falls back on an invalid one', () => {
    expect(
      securityAlertsSettings({
        channels: ['C0123WIDGET'],
        severities: ['high'],
        language: 'German',
      }),
    ).toMatchObject({ channels: ['C0123WIDGET'], severities: ['high'], language: 'German' })
    expect(securityAlertsSettings({ channels: ['#widgets'] }).channels).toEqual([])
  })

  test('is one value for every repository', () => {
    expect(securityAlertsDefinition.global).toBe(true)
  })
})
