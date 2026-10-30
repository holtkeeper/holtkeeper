import { describe, expect, test } from 'bun:test'

import { toForgeDraft, toForgeInput, validateForgeDraft } from './forge-form.ts'

describe('forge form', () => {
  test('needs an id, an http(s) URL and a token', () => {
    expect(validateForgeDraft(toForgeDraft(), [])).toEqual({
      id: 'Lowercase letters, digits and dashes',
      url: 'An http(s) URL',
      credentialId: 'Choose the token credential',
    })
    expect(
      validateForgeDraft(
        { id: 'work', url: 'ssh://gitlab.test', credentialId: 'c1', packages: false },
        ['work'],
      ),
    ).toEqual({ id: 'A forge with this id exists', url: 'An http(s) URL' })
  })

  test('round-trips an entry and trims the URL', () => {
    const draft = toForgeDraft({
      type: 'forge',
      id: 'work',
      provenance: 'panel',
      data: { kind: 'gitlab', url: 'https://gitlab.test', credentialId: 'c1' },
    })
    expect(validateForgeDraft(draft, [])).toEqual({})
    expect(toForgeInput({ ...draft, url: ' https://gitlab.test/ ' })).toEqual({
      kind: 'gitlab',
      url: 'https://gitlab.test',
      credentialId: 'c1',
    })
  })

  test('sends packages only when on', () => {
    const draft = toForgeDraft({
      type: 'forge',
      id: 'work',
      provenance: 'panel',
      data: { kind: 'gitlab', url: 'https://gitlab.test', credentialId: 'c1', packages: true },
    })
    expect(draft.packages).toBe(true)
    expect(toForgeInput(draft).packages).toBe(true)
    expect(toForgeInput({ ...draft, packages: false })).not.toHaveProperty('packages')
  })
})
