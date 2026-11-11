import { describe, expect, test } from 'bun:test'

import { forgeLinks } from './links.ts'
import { buildEntries, digestSummary, renderChangelog, suggestBump } from './notes.ts'
import { releaseSettings } from './settings.ts'
import type { ReleaseCommit } from './types.ts'

let counter = 0
const commit = (subject: string, body = '', parents = 1): ReleaseCommit => {
  counter++
  return {
    sha: counter.toString(16).padStart(40, '0'),
    parents: Array.from({ length: parents }, (_, i) => `p${counter}${i}`),
    author: { name: `Dev ${counter % 2}`, email: `dev${counter % 2}@example.com` },
    date: new Date(Date.UTC(2026, 9, 1, 0, counter)).toISOString(),
    subject,
    body,
  }
}

const settings = releaseSettings()

describe('entries', () => {
  test('collapses repeated messages and drops merges by default', () => {
    const entries = buildEntries(
      [
        commit('feat: [ABC-1] Widget panel'),
        commit('feat: [ABC-1] widget panel.'),
        commit('fix(ui): broken button'),
        commit("Merge branch 'feature/x' into 'development'", 'See merge request g/a!12', 2),
      ],
      settings.changelog,
    )
    expect(entries.map((entry) => [entry.section, entry.text, entry.commits.length])).toEqual([
      ['features', 'widget panel.', 2],
      ['fixes', 'broken button', 1],
    ])
    expect(entries[0]?.tickets).toEqual(['ABC-1'])
  })

  test('applies rules, revert pairs and edits', () => {
    const reverted = commit('feat: risky thing')
    const entries = buildEntries(
      [
        reverted,
        commit('Revert "feat: risky thing"', `This reverts commit ${reverted.sha}.`),
        commit('ci: faster pipeline'),
        commit('chore(deps): bump x'),
        commit('fix: keep me'),
      ],
      releaseSettings({ changelog: { excludeTypes: ['ci', 'chore'] } }).changelog,
    )
    const byText = Object.fromEntries(entries.map((entry) => [entry.title, entry.excludedBy]))
    expect(byText).toEqual({
      'risky thing': 'revert',
      'feat: risky thing': 'revert',
      'faster pipeline': 'rule',
      'bump x': 'rule',
      'keep me': undefined,
    })

    const keep = entries.find((entry) => entry.title === 'keep me')!
    const ci = entries.find((entry) => entry.title === 'faster pipeline')!
    const edited = buildEntries(
      [commit('ci: faster pipeline'), commit('fix: keep me')],
      releaseSettings({ changelog: { excludeTypes: ['ci'] } }).changelog,
      {
        excluded: [keep.id],
        included: [ci.id],
        texts: { [ci.id]: 'Pipelines take half the time' },
      },
    )
    expect(edited.map((entry) => [entry.text, entry.included, entry.excludedBy])).toEqual([
      ['keep me', false, 'person'],
      ['Pipelines take half the time', true, undefined],
    ])
  })
})

const entriesOf = (...subjects: string[]) =>
  buildEntries(
    subjects.map((subject) => commit(subject)),
    settings.changelog,
  )

describe('bump', () => {
  test('takes the largest bump with reasons', () => {
    const result = suggestBump(entriesOf('feat: a', 'fix: b', 'fix: c'), { current: '1.2.3' })
    expect(result.bump).toBe('minor')
    expect(result.reasons.map((reason) => [reason.bump, reason.because])).toEqual([
      ['minor', '1 feat'],
      ['patch', '2 fixes'],
    ])
  })

  test('breaking changes bump minor while the major version is 0', () => {
    const entries = entriesOf('feat!: drop old api')
    expect(entries[0]?.bump).toBe('major')
    expect(suggestBump(entries, { current: '0.4.0' }).bump).toBe('minor')
    expect(suggestBump(entries, { current: '1.4.0' })).toEqual({
      bump: 'major',
      reasons: [{ bump: 'major', because: '1 breaking change', entries: [entries[0]!.id] }],
    })
  })

  test('reads the type after a leading ticket key and footers', () => {
    expect(suggestBump(entriesOf('ABC-4 feat: add shapes')).bump).toBe('minor')
    const footer = buildEntries(
      [commit('fix: rename size', 'BREAKING CHANGE: width now')],
      settings.changelog,
    )
    expect(suggestBump(footer, { current: '2.0.0' }).bump).toBe('major')
  })

  test('anything else is a patch, nothing is none', () => {
    expect(suggestBump(entriesOf('docs: readme', 'tidy up')).bump).toBe('patch')
    expect(suggestBump([]).bump).toBe('none')
  })
})

describe('rendering', () => {
  const links = forgeLinks({
    kind: 'gitlab',
    webUrl: 'https://gitlab.example.com/g/a',
    ticketUrl: 'https://jira.example.com/browse/{id}',
  })
  const entries = buildEntries(
    [commit('feat(grid): [ABC-7] idle mode (!3)'), commit('fix: crash'), commit('feat!: new api')],
    settings.changelog,
  )

  test('groups by section with links', () => {
    const markdown = renderChangelog(entries, links)
    expect(markdown).toContain('### Breaking changes\n\n- new api (')
    expect(markdown).toContain(
      '### Features\n\n- **grid:** idle mode ([ABC-7](https://jira.example.com/browse/ABC-7), [!3](https://gitlab.example.com/g/a/-/merge_requests/3))',
    )
    expect(markdown).toMatch(/### Fixes\n\n- crash \(\[[0-9a-f]{8}\]\(https:\/\/gitlab/)
  })

  test('without links names references plainly', () => {
    expect(renderChangelog(entries)).toContain('- **grid:** idle mode (ABC-7, !3)')
  })

  test('digests counts and highlights', () => {
    expect(digestSummary(entries)).toBe(
      '1 breaking change, 1 feature, 1 fix across 1 ticket.\n\n- new api\n- **grid:** idle mode',
    )
  })
})
