import { describe, expect, test } from 'bun:test'

import { findTickets, parseCommit } from './conventional.ts'

describe('parseCommit', () => {
  test('conventional commit with ticket in brackets', () => {
    const parsed = parseCommit('feat: [ABC-435] add login by passkey')
    expect(parsed).toMatchObject({
      type: 'feat',
      breaking: false,
      description: 'add login by passkey',
      tickets: ['ABC-435'],
      merge: false,
      wip: false,
    })
    expect(parsed.scope).toBeUndefined()
  })

  test('scope, bang and Russian description', () => {
    expect(parseCommit('fix(upload)!: повторять загрузку при обрыве')).toMatchObject({
      type: 'fix',
      scope: 'upload',
      breaking: true,
      description: 'повторять загрузку при обрыве',
    })
  })

  test('BREAKING CHANGE footer', () => {
    const parsed = parseCommit(
      'refactor(api): rename endpoints',
      'Moves everything under /v2.\n\nBREAKING CHANGE: /audit is now /v2/audits\n\nRefs ABC-12',
    )
    expect(parsed.breaking).toBe(true)
    expect(parsed.breakingNote).toBe('/audit is now /v2/audits')
    expect(parsed.tickets).toEqual(['ABC-12'])
  })

  test('type aliases and unknown types', () => {
    expect(parseCommit('Feature: dark mode').type).toBe('feat')
    expect(parseCommit('bugfix(ui): kerning').type).toBe('fix')
    expect(parseCommit('i18n: add Russian').type).toBe('i18n')
  })

  test('plain subjects keep the subject as description', () => {
    const parsed = parseCommit('Обновил README')
    expect(parsed.type).toBeUndefined()
    expect(parsed.description).toBe('Обновил README')
  })

  test('ticket before the conventional type', () => {
    expect(parseCommit('[ABC-12] feat(ui): add dark theme')).toMatchObject({
      type: 'feat',
      scope: 'ui',
      description: 'add dark theme',
      tickets: ['ABC-12'],
    })
    expect(parseCommit('ABC-13: fix!: drop the old cache')).toMatchObject({
      type: 'fix',
      breaking: true,
      description: 'drop the old cache',
    })
  })

  test('ticket key prefix without brackets', () => {
    expect(parseCommit('ABC-77: Поправить вёрстку')).toMatchObject({
      description: 'Поправить вёрстку',
      tickets: ['ABC-77'],
    })
  })

  test('GitHub squash suffix is a pull request, not a ticket', () => {
    const parsed = parseCommit('fix: handle empty lockfile (#123)', 'Closes #99')
    expect(parsed.mergeRequests).toEqual([123])
    expect(parsed.tickets).toEqual(['#99'])
    expect(parsed.description).toBe('handle empty lockfile')
  })

  test('GitLab merge commit takes the title from the body', () => {
    const parsed = parseCommit(
      "Merge branch 'feature/ABC-435-passkeys' into 'main'",
      'feat: [ABC-435] passkeys\n\nCloses ABC-435\n\nSee merge request games/app!42',
    )
    expect(parsed).toMatchObject({
      merge: true,
      type: 'feat',
      description: 'passkeys',
      mergeRequests: [42],
      tickets: ['ABC-435'],
    })
  })

  test('GitHub merge commit', () => {
    const parsed = parseCommit('Merge pull request #7 from octo/fix-typo', 'Fix typo in docs')
    expect(parsed).toMatchObject({
      merge: true,
      mergeRequests: [7],
      description: 'Fix typo in docs',
    })
    expect(parsed.tickets).toEqual([])
  })

  test('GitLab short MR reference', () => {
    expect(parseCommit('chore: bump deps, see !15').mergeRequests).toEqual([15])
  })

  test('git revert', () => {
    const parsed = parseCommit(
      'Revert "feat: [ABC-1] new cache"',
      'This reverts commit 0123456789abcdef0123456789abcdef01234567.',
    )
    expect(parsed).toMatchObject({
      type: 'revert',
      description: 'feat: [ABC-1] new cache',
      revert: {
        subject: 'feat: [ABC-1] new cache',
        sha: '0123456789abcdef0123456789abcdef01234567',
      },
    })
  })

  test('co-authors', () => {
    const parsed = parseCommit(
      'feat: pairing',
      'Co-authored-by: Ann Lee <ann@example.com>\nco-authored-by: Иван <ivan@example.com>',
    )
    expect(parsed.coAuthors).toEqual([
      { name: 'Ann Lee', email: 'ann@example.com' },
      { name: 'Иван', email: 'ivan@example.com' },
    ])
  })

  test('wip and fixup markers', () => {
    expect(parseCommit('WIP: feat: draft')).toMatchObject({
      wip: true,
      type: 'feat',
      description: 'draft',
    })
    expect(parseCommit('fixup! fix: retry upload')).toMatchObject({ wip: true, type: 'fix' })
    expect(parseCommit('wipe stale cache').wip).toBe(false)
  })
})

describe('findTickets', () => {
  test('ignores encodings and standards that look like keys', () => {
    expect(findTickets('Use UTF-8 and ISO-8601 for ABC-1, then #4')).toEqual(['ABC-1', '#4'])
  })

  test('ignores html entities and urls', () => {
    expect(findTickets('see https://x.test/a#12 and &#39;')).toEqual([])
  })
})
