import { describe, expect, test } from 'bun:test'

import {
  toForgeDraft,
  toForgeInput,
  validateFleetPattern,
  validateForgeDraft,
} from './forge-form.ts'

describe('forge form', () => {
  test('needs an id, an http(s) URL and a token', () => {
    expect(validateForgeDraft(toForgeDraft(), [])).toEqual({
      id: 'Lowercase letters, digits and dashes',
      url: 'An http(s) URL',
      credentialId: 'Choose the token credential',
    })
    expect(
      validateForgeDraft(
        {
          id: 'work',
          url: 'ssh://gitlab.test',
          credentialId: 'c1',
          packages: true,
          cachePackages: false,
          botUsername: '',
          include: [],
          exclude: [],
        },
        ['work'],
      ),
    ).toEqual({ id: 'A forge with this id exists', url: 'An http(s) URL' })
  })

  test('round-trips an entry and trims the URL', () => {
    const draft = toForgeDraft({
      type: 'forge',
      id: 'work',
      data: { kind: 'gitlab', url: 'https://gitlab.test', credentialId: 'c1' },
    })
    expect(validateForgeDraft(draft, [])).toEqual({})
    expect(toForgeInput({ ...draft, url: ' https://gitlab.test/ ' })).toEqual({
      kind: 'gitlab',
      url: 'https://gitlab.test',
      credentialId: 'c1',
    })
  })

  test('packages are on by default and sent only when turned off', () => {
    expect(toForgeDraft().packages).toBe(true)
    const draft = toForgeDraft({
      type: 'forge',
      id: 'work',
      data: { kind: 'gitlab', url: 'https://gitlab.test', credentialId: 'c1', packages: false },
    })
    expect(draft.packages).toBe(false)
    expect(toForgeInput(draft).packages).toBe(false)
    expect(toForgeInput({ ...draft, packages: true })).not.toHaveProperty('packages')
  })

  test('the bot username is trimmed and left out when empty', () => {
    expect(toForgeInput(toForgeDraft())).not.toHaveProperty('botUsername')
    expect(toForgeInput({ ...toForgeDraft(), botUsername: ' keeper ' })).toMatchObject({
      botUsername: 'keeper',
    })
  })

  test('package caching is off by default and sent only together with packages', () => {
    const draft = toForgeDraft()
    expect(draft.cachePackages).toBe(false)
    expect(toForgeInput({ ...draft, cachePackages: true })).toMatchObject({ cachePackages: true })
    expect(toForgeInput({ ...draft, packages: false, cachePackages: true })).not.toHaveProperty(
      'cachePackages',
    )
  })

  test('fleet patterns round-trip, are sent only when present and carry no forge prefix', () => {
    const draft = toForgeDraft({
      type: 'forge',
      id: 'work',
      data: {
        kind: 'gitlab',
        url: 'https://gitlab.test',
        credentialId: 'c1',
        include: ['acme/round/**'],
        exclude: ['acme/round/sandbox-*'],
      },
    })
    expect(draft).toMatchObject({ include: ['acme/round/**'], exclude: ['acme/round/sandbox-*'] })
    expect(toForgeInput(draft)).toMatchObject({
      include: ['acme/round/**'],
      exclude: ['acme/round/sandbox-*'],
    })
    expect(toForgeInput(toForgeDraft())).not.toHaveProperty('include')
    expect(validateFleetPattern('work:acme/**')).toBe(
      'No forge prefix: the patterns apply to this forge',
    )
    expect(validateFleetPattern('**/web')).toBe('Start with a folder, e.g. acme/**')
    expect(validateForgeDraft({ ...draft, include: ['**/web'] }, [])).toEqual({
      include: 'Start with a folder, e.g. acme/**',
    })
  })
})
