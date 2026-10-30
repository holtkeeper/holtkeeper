import { describe, expect, test } from 'bun:test'

import {
  challengeMatches,
  generateChallengeCode,
  hashChallengeCode,
  normalizeChallengeCode,
  parseVerifyCommand,
} from './challenge.ts'

describe('challenge codes', () => {
  test('are random, formatted and folded when compared', () => {
    const codes = new Set(Array.from({ length: 50 }, generateChallengeCode))
    expect(codes.size).toBe(50)
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(normalizeChallengeCode('ab1o-il2z')).toBe('AB10112Z')
    const hash = hashChallengeCode('acc', 'AB10-112Z')
    expect(challengeMatches('acc', 'ab1o il2z', hash)).toBe(true)
    expect(challengeMatches('other', 'AB10-112Z', hash)).toBe(false)
    expect(challengeMatches('acc', 'AB10-112Y', hash)).toBe(false)
  })

  test('parseVerifyCommand finds the code in comments and messages', () => {
    expect(parseVerifyCommand('/holtkeeper verify AB12-CD34')).toBe('AB12-CD34')
    expect(parseVerifyCommand('thanks!\n/holtkeeper  verify `ab12cd34`.')).toBe('ab12cd34')
    expect(parseVerifyCommand('please /holtkeeper verify AB12-CD34 now')).toBe('AB12-CD34')
    expect(parseVerifyCommand('/holtkeeper verify')).toBeUndefined()
    expect(parseVerifyCommand('x/holtkeeper verify AB12-CD34')).toBeUndefined()
    expect(parseVerifyCommand('/holtkeeper verify AB12-CD34-EF')).toBeUndefined()
  })
})
