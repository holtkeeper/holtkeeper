import { describe, expect, test } from 'bun:test'

import {
  parsePastedPaths,
  parseRepoHubSearch,
  parseRepoKey,
  parseRepoSplat,
  pathCheck,
  repoInitials,
  repoKey,
  repoName,
  repoSplat,
  splitRepoPath,
  suggestRepos,
  validateGroupId,
  validateRepoPath,
  withRepos,
} from './repo.ts'

test('repo keys round-trip', () => {
  const repo = { forge: 'work', path: 'games/app-x' }
  expect(repoKey(repo)).toBe('work:games/app-x')
  expect(parseRepoKey('work:games/app-x')).toEqual(repo)
  expect(parseRepoKey('nope')).toBeUndefined()
  expect(parseRepoKey(':x')).toBeUndefined()
  expect(parseRepoKey(undefined)).toBeUndefined()
  expect(repoName(repo)).toBe('app-x')
})

test('hub splats round-trip and reject a missing forge or path', () => {
  const repo = { forge: 'work', path: 'acme/sub/widget-kit' }
  expect(repoSplat(repo)).toBe('work/acme/sub/widget-kit')
  expect(parseRepoSplat('work/acme/sub/widget-kit')).toEqual(repo)
  expect(parseRepoSplat('/work/acme/widget-kit/')).toEqual({
    forge: 'work',
    path: 'acme/widget-kit',
  })
  for (const splat of [undefined, '', 'work', 'work/', '/acme']) {
    expect(parseRepoSplat(splat)).toBeUndefined()
  }
})

test('hub search keeps known tabs and non-empty strings only', () => {
  expect(
    parseRepoHubSearch({ tab: 'quality', section: 'assets', file: 'img/a.png', ref: 'abc' }),
  ).toEqual({ tab: 'quality', section: 'assets', file: 'img/a.png', ref: 'abc' })
  expect(parseRepoHubSearch({ tab: 'assets', section: '', file: 3, ref: undefined })).toEqual({})
  expect(parseRepoHubSearch({ tab: 'settings', section: 'updates' })).toEqual({
    tab: 'settings',
    section: 'updates',
  })
})

test('repository paths and group ids are checked before saving', () => {
  expect(validateRepoPath('games/app')).toBeUndefined()
  expect(validateRepoPath('')).toBe('Enter the repository path')
  expect(validateRepoPath('/games/app')).toBe('No leading or trailing "/"')
  expect(validateRepoPath('games/*')).toBe('Use an exact path; edit the group for patterns')
  expect(validateRepoPath('app')).toBe('Include the namespace: team/app')
  expect(validateGroupId('games-2')).toBeUndefined()
  expect(validateGroupId('Games')).toBe('Lowercase letters, digits and dashes')
})

test('withRepos adds paths once and lifts their exclusion', () => {
  expect(withRepos(undefined, 'work', ['games/app', 'games/app', 'games/tool'])).toEqual({
    forge: 'work',
    include: ['games/app', 'games/tool'],
    exclude: [],
  })
  const group = { forge: 'work', include: ['games/*'], exclude: ['games/app', 'games/old'] }
  expect(withRepos(group, 'other', ['games/app'])).toEqual({
    forge: 'work',
    include: ['games/*', 'games/app'],
    exclude: ['games/old'],
  })
  expect(withRepos(withRepos(group, 'work', ['games/app']), 'work', ['games/app']).include).toEqual(
    ['games/*', 'games/app'],
  )
})

describe('parsePastedPaths', () => {
  test('reads one path per line, trims forge URLs and clone addresses, skips repeats', () => {
    expect(
      parsePastedPaths(
        [
          'acme/widget-kit',
          '',
          '  https://gitlab.acme.dev/acme/payments/ledger-api/-/tree/main  ',
          'https://github.com/acme/http-client/pull/12',
          'git@gitlab.acme.dev:acme/notify-svc.git',
          'acme/widget-kit, acme/search-svc',
        ].join('\n'),
      ),
    ).toEqual({
      paths: [
        'acme/widget-kit',
        'acme/payments/ledger-api',
        'acme/http-client',
        'acme/notify-svc',
        'acme/search-svc',
      ],
      fromUrl: ['acme/payments/ledger-api', 'acme/http-client', 'acme/notify-svc'],
      invalid: [],
    })
  })

  test('reports lines that are no exact path', () => {
    expect(parsePastedPaths('widget\nacme/*\nhttps://gitlab.acme.dev/\n')).toEqual({
      paths: [],
      fromUrl: [],
      invalid: [
        { line: 'widget', error: 'Include the namespace: team/app' },
        { line: 'acme/*', error: 'Use an exact path; edit the group for patterns' },
        { line: 'https://gitlab.acme.dev/', error: 'Enter the repository path' },
      ],
    })
    expect(parsePastedPaths('   \n')).toEqual({ paths: [], fromUrl: [], invalid: [] })
  })
})

test('splitRepoPath separates the namespace from the name', () => {
  expect(splitRepoPath('acme/billing/frontend-libs')).toEqual({
    namespace: 'acme/billing/',
    name: 'frontend-libs',
  })
  expect(splitRepoPath('solo')).toEqual({ namespace: '', name: 'solo' })
})

test('repoInitials match the server-generated avatar', () => {
  expect(repoInitials('acme/data-tools/dealer-frontend')).toBe('DD')
  expect(repoInitials('game-frontend')).toBe('GF')
  expect(repoInitials('api')).toBe('AP')
})

const account = { username: 'holtkeeper-bot' }
const ready = (result: Parameters<typeof pathCheck>[0] & object) => pathCheck(result).ready

describe('pathCheck', () => {
  test('names the account to invite when the repository is not visible', () => {
    const check = pathCheck({ path: 'team/app', status: 'not-found' }, { account })
    expect(check).toMatchObject({ label: 'Not found', tone: 'danger', ready: false })
    expect(check.why).toContain('@holtkeeper-bot is not a member')
    expect(pathCheck({ path: 'team/app', status: 'not-found' }).why).toContain(
      'the account of the forge token',
    )
  })

  test('only readable paths and unanswered checks are ready; added ones are skipped', () => {
    expect(ready({ path: 'a/b', status: 'ok' })).toBe(true)
    expect(ready({ path: 'a/b', status: 'error', message: 'timeout' })).toBe(true)
    expect(ready({ path: 'a/b', status: 'unauthorized' })).toBe(false)
    expect(ready({ path: 'a/b', status: 'forbidden' })).toBe(false)
    expect(ready({ path: 'a/b', status: 'archived' })).toBe(false)
    expect(pathCheck({ path: 'a/b', status: 'ok' }, { added: true })).toMatchObject({
      label: 'Already added',
      ready: false,
    })
    expect(pathCheck(undefined, { fromUrl: true })).toMatchObject({
      label: 'Not checked',
      why: 'Trimmed from a forge URL',
      ready: false,
    })
  })
})

describe('suggestRepos', () => {
  const repos = [
    { forge: 'work', path: 'acme/checkout-web' },
    { forge: 'work', path: 'acme/checkout-api' },
    { forge: 'work', path: 'acme/widgets' },
    { forge: 'hub', path: 'tools/gadget' },
  ]

  test('suggests visible repositories a few typos away, closest first', () => {
    expect(suggestRepos('acme/checkout-wb', repos)).toEqual([
      { forge: 'work', path: 'acme/checkout-web' },
      { forge: 'work', path: 'acme/checkout-api' },
    ])
    expect(suggestRepos('work:acme/widget', repos)).toEqual([
      { forge: 'work', path: 'acme/widgets' },
    ])
    expect(suggestRepos('/gadgt/', repos)).toEqual([{ forge: 'hub', path: 'tools/gadget' }])
  })

  test('says nothing for unrelated addresses, empty input or exact matches', () => {
    expect(suggestRepos('supply/licenses', repos)).toEqual([])
    expect(suggestRepos('  ', repos)).toEqual([])
    expect(suggestRepos('work:acme/widgets', repos)).toEqual([])
    expect(suggestRepos('acme/widgets', [])).toEqual([])
  })

  test('caps the number of suggestions', () => {
    expect(suggestRepos('acme/checkout', repos, 1)).toEqual([
      { forge: 'work', path: 'acme/checkout-api' },
    ])
  })
})
