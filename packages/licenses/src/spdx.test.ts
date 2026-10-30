import { describe, expect, test } from 'bun:test'

import { defaultAllow, defaultDeny } from './model.ts'
import { evaluateLicenses, formatLicense, type LicenseVerdict, parseLicense } from './spdx.ts'

const policy = { allow: defaultAllow, deny: defaultDeny }

describe('evaluateLicenses with the default policy', () => {
  const cases: [string[], LicenseVerdict, string[]][] = [
    [['MIT'], 'allowed', []],
    [['mit'], 'allowed', []],
    [['Apache-2.0'], 'allowed', []],
    [['Apache-2.0+'], 'allowed', []],
    [['MIT OR GPL-3.0-only'], 'allowed', []],
    [['GPL-3.0-only OR MIT'], 'allowed', []],
    [['(MIT OR Apache-2.0)'], 'allowed', []],
    [['MIT AND ISC'], 'allowed', []],
    [['MIT AND GPL-3.0-or-later'], 'denied', ['GPL-3.0-or-later']],
    [['GPL-2.0'], 'denied', ['GPL-2.0']],
    [['GPL-2.0+'], 'denied', ['GPL-2.0+']],
    [['AGPL-3.0-only'], 'denied', ['AGPL-3.0-only']],
    [['SSPL-1.0'], 'denied', ['SSPL-1.0']],
    [['LGPL-2.1-only'], 'unlisted', ['LGPL-2.1-only']],
    [['MPL-2.0'], 'unlisted', ['MPL-2.0']],
    [['MPL-2.0 OR GPL-3.0-only'], 'unlisted', ['MPL-2.0', 'GPL-3.0-only']],
    [['(MIT AND BSD-3-Clause) OR GPL-2.0-only'], 'allowed', []],
    [['MIT AND (GPL-2.0-only OR LGPL-2.1-only)'], 'unlisted', ['GPL-2.0-only', 'LGPL-2.1-only']],
    [
      ['GPL-2.0-only WITH Classpath-exception-2.0'],
      'denied',
      ['GPL-2.0-only WITH Classpath-exception-2.0'],
    ],
    [['mit or apache-2.0'], 'allowed', []],
    [['MIT', 'ISC'], 'allowed', []],
    [['MIT', 'GPL-3.0-only'], 'denied', ['GPL-3.0-only']],
    [[], 'unknown', ['UNKNOWN']],
    [['UNKNOWN'], 'unknown', ['UNKNOWN']],
    [['NOASSERTION'], 'unknown', ['NOASSERTION']],
    [['non-standard'], 'unknown', ['non-standard']],
    [['LicenseRef-Proprietary'], 'unknown', ['LicenseRef-Proprietary']],
    [['see LICENSE.md file'], 'unknown', ['see LICENSE.md file']],
    [['MIT OR UNKNOWN'], 'allowed', []],
    [['UNKNOWN OR GPL-3.0-only'], 'unknown', ['UNKNOWN', 'GPL-3.0-only']],
    [['MIT AND UNKNOWN'], 'unknown', ['UNKNOWN']],
    [['MIT AND'], 'unknown', ['MIT AND']],
    [['(MIT'], 'unknown', ['(MIT']],
  ]
  for (const [licenses, verdict, culprits] of cases)
    test(`${JSON.stringify(licenses)} → ${verdict}`, () => {
      expect(evaluateLicenses(licenses, policy)).toEqual({ verdict, culprits })
    })
})

describe('policy entries', () => {
  test('an allowed WITH exception overrides a denied base license', () => {
    const custom = {
      allow: [...defaultAllow, 'GPL-2.0-only WITH Classpath-exception-2.0'],
      deny: defaultDeny,
    }
    expect(evaluateLicenses(['GPL-2.0-only WITH Classpath-exception-2.0'], custom).verdict).toBe(
      'allowed',
    )
    expect(evaluateLicenses(['GPL-2.0-only'], custom).verdict).toBe('denied')
  })

  test('whole expressions match regardless of operand order and case', () => {
    const custom = { allow: ['MPL-2.0 AND MIT'], deny: [] }
    expect(evaluateLicenses(['mit and MPL-2.0'], custom).verdict).toBe('allowed')
    expect(evaluateLicenses(['MPL-2.0'], custom).verdict).toBe('unlisted')
  })

  test('deny wins over allow and wildcards stay within one id', () => {
    expect(
      evaluateLicenses(['GPL-3.0-only'], { allow: ['GPL-3.0-only'], deny: ['GPL-*'] }).verdict,
    ).toBe('denied')
    expect(evaluateLicenses(['LGPL-3.0-only'], { allow: [], deny: ['GPL-*'] }).verdict).toBe(
      'unlisted',
    )
    expect(evaluateLicenses(['BSD-3-Clause'], { allow: ['BSD-*'], deny: [] }).verdict).toBe(
      'allowed',
    )
  })
})

test('parseLicense builds a precedence-aware tree', () => {
  expect(parseLicense('MIT OR ISC AND BSD-2-Clause')).toEqual({
    type: 'or',
    items: [
      { type: 'license', id: 'MIT', plus: false },
      {
        type: 'and',
        items: [
          { type: 'license', id: 'ISC', plus: false },
          { type: 'license', id: 'BSD-2-Clause', plus: false },
        ],
      },
    ],
  })
  expect(formatLicense(parseLicense('(isc and MIT) or Apache-2.0+'))).toBe(
    '(isc AND MIT) OR Apache-2.0+',
  )
})
