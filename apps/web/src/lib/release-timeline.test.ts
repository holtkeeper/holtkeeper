import { describe, expect, test } from 'bun:test'

import type { ReleaseEntry, ReleaseSettings, ReleaseVersionView } from '@holtkeeper/api'

import {
  acceptedVia,
  attemptLine,
  awaitsAcceptance,
  changesText,
  checklistRows,
  deployKind,
  environmentOrder,
  filterVersions,
  flowSummary,
  gateRows,
  liveOn,
  stepBlockedBy,
  versionDeployCell,
  versionEnvironments,
  versionNotesText,
  versionTicks,
} from './release-timeline.ts'

const entry = (id: string, included = true): ReleaseEntry => ({
  id,
  section: 'features',
  breaking: false,
  bump: 'minor',
  title: id,
  text: id,
  tickets: [],
  mergeRequests: [],
  commits: [],
  authors: [],
  included,
})

const version = (tag: string, extra: Partial<ReleaseVersionView> = {}): ReleaseVersionView => ({
  tag,
  version: tag.replace(/^v/, ''),
  sha: `${tag}-sha`,
  commitCount: 2,
  capped: false,
  tickets: [],
  bump: 'patch',
  deploys: [],
  ...extra,
})

const settings = (extra: Partial<ReleaseSettings['flow']> = {}) =>
  ({
    flow: { mode: 'trunk', source: 'develop', ...extra },
    version: { scheme: 'semver', tagFormat: 'v{version}', prerelease: false },
  }) as ReleaseSettings

describe('header and gates', () => {
  test('summarizes the flow', () => {
    expect(flowSummary({ settings: settings(), row: { target: 'main' } as never })).toBe(
      'Trunk flow · versions are tagged on main as v1.4.0',
    )
    expect(
      flowSummary({
        settings: settings({ mode: 'merge-request' }),
        row: { target: 'main' } as never,
      }),
    ).toBe('develop → main through a release merge request · tagged as v1.4.0')
    expect(flowSummary({ settings: settings({ mode: 'external' }), row: {} as never })).toBe(
      'Released by another tool',
    )
  })

  test('turns gates into checklist lines with their severity in words', () => {
    const rows = gateRows([
      { id: 'pipeline', ok: true, severity: 'block', message: 'main pipeline success' },
      {
        id: 'acceptance',
        ok: false,
        severity: 'block',
        message: 'the changes are not accepted yet',
      },
      { id: 'changelog', ok: false, severity: 'warn', message: 'no entries' },
      { id: 'pipeline', ok: true, severity: 'info', message: 'main has no pipeline' },
    ])
    expect(rows.map((row) => [row.text, row.tone, row.severityText])).toEqual([
      ['Main pipeline success', 'success', 'blocks'],
      ['The changes are not accepted yet', 'danger', 'blocks'],
      ['No entries', 'warning', 'warns'],
      ['Main has no pipeline', 'success', 'info'],
    ])
  })

  test('keeps exactly one changelog line with what the changelog holds', () => {
    const plan = {
      entries: [entry('a'), entry('b'), entry('c', false)],
      changelog: '- a\n- b',
      summary: { markdown: '', source: 'agent' as const },
    }
    const failing = checklistRows(
      {
        ...plan,
        gates: [
          { id: 'pipeline', ok: true, severity: 'block', message: 'main pipeline success' },
          {
            id: 'changelog',
            ok: false,
            severity: 'warn',
            message: '1 of 2 entries are not conventional commits',
          },
        ],
      },
      true,
    )
    const changelog = failing.filter((row) => row.id === 'changelog')
    expect(changelog).toHaveLength(1)
    expect(changelog[0]).toMatchObject({
      ok: false,
      tone: 'warning',
      text: '1 of 2 entries are not conventional commits',
      detail: '2 entries · 1 left out · notes written by AI · prepended to CHANGELOG.md',
    })

    const empty = checklistRows(
      {
        entries: [],
        changelog: '',
        summary: { markdown: '', source: 'none' },
        gates: [{ id: 'empty', ok: false, severity: 'block', message: 'no changes' }],
      },
      false,
    )
    expect(empty.filter((row) => row.id === 'changelog').map((row) => row.text)).toEqual([
      'Changelog empty',
    ])
  })

  test('keeps the step closed while a hard gate fails or acceptance is missing', () => {
    const waiting = { acceptanceRequired: true }
    const accepted = {
      acceptanceRequired: true,
      acceptance: { sha: 's', by: 'u1', at: '2026-01-01', via: 'manual' as const },
    }
    expect(awaitsAcceptance(waiting)).toBe(true)
    expect(awaitsAcceptance(accepted)).toBe(false)
    expect(awaitsAcceptance({ acceptanceRequired: false })).toBe(false)
    expect(stepBlockedBy('version', [], waiting)).toBe('Opens after acceptance')
    expect(stepBlockedBy('propose', [], waiting)).toBeUndefined()
    expect(stepBlockedBy('version', [], accepted)).toBeUndefined()
    expect(
      stepBlockedBy(
        'version',
        [{ id: 'tag-exists', ok: false, severity: 'block', message: 'v1.0.0 exists' }],
        accepted,
      ),
    ).toBe('V1.0.0 exists')
  })
})

describe('environments', () => {
  test('offers the deploy action the status allows', () => {
    expect(deployKind('ready')).toBe('deploy')
    expect(deployKind('waiting')).toBe('deploy')
    expect(deployKind('failed')).toBe('retry')
    expect(deployKind('success')).toBe('redeploy')
    expect(deployKind('running')).toBeUndefined()
  })

  test('describes the order and attempts', () => {
    expect(environmentOrder({ confirm: false })).toBe('right after the tag')
    expect(environmentOrder({ after: 'staging', confirm: true })).toBe(
      'after staging · asks before starting',
    )
    const people = { u1: { name: 'Ana S.', avatarUrl: '/a.svg' } }
    expect(
      attemptLine(
        {
          jobId: 3,
          status: 'success',
          webUrl: 'u',
          actor: 'u1',
          reason: 'redeploy',
          durationSeconds: 192,
        },
        people,
      ),
    ).toEqual({
      status: 'Deployed',
      tone: 'success',
      by: 'started by Ana S.',
      reason: 'redeploy',
      duration: '3 min 12 s',
    })
    expect(attemptLine({ jobId: 1, status: 'failed', webUrl: 'u' }, people)).toEqual({
      status: 'Failed',
      tone: 'danger',
    })
  })

  test('lists what runs a tag now', () => {
    expect(
      liveOn(
        [
          { name: 'staging', tag: 'v2.0.0', status: 'success' },
          { name: 'production', tag: 'v1.9.0', status: 'success' },
        ],
        'v2.0.0',
      ),
    ).toEqual(['staging'])
  })
})

describe('versions', () => {
  const deployed = version('v1.1.0', {
    bump: 'minor',
    tickets: ['ABC-12'],
    deploys: [
      { environment: 'staging', status: 'succeeded', at: '2026-01-02', actor: 'u1' },
      { environment: 'qa', status: 'failed', at: '2026-01-02', actor: 'u1' },
      { environment: 'production', status: 'started', at: '2026-01-03', actor: 'u1' },
    ],
  })
  const plain = version('v1.0.1')

  test('builds the environment columns and cells', () => {
    expect(versionEnvironments(['staging', 'production'], [plain, deployed])).toEqual([
      'staging',
      'production',
      'qa',
    ])
    expect(versionDeployCell(deployed, 'staging')).toEqual({ label: 'Deployed', tone: 'success' })
    expect(versionDeployCell(deployed, 'qa')).toEqual({ label: 'Failed', tone: 'danger' })
    expect(versionDeployCell(deployed, 'production')).toEqual({ label: 'Deploying', tone: 'info' })
    expect(versionDeployCell(plain, 'staging')).toEqual({ label: 'Not deployed', tone: 'none' })
    expect(
      versionTicks(deployed, ['staging', 'ops']).map((tick) => [tick.tone, tick.label]),
    ).toEqual([
      ['success', 'staging: deployed'],
      ['skipped', 'ops: not deployed'],
    ])
  })

  test('counts changes', () => {
    expect(changesText(deployed)).toBe('2 commits · 1 task')
    expect(changesText(version('v1', { commitCount: 300, capped: true }))).toBe(
      '300+ commits · 0 tasks',
    )
    expect(changesText(version('v1', { commitCount: 1 }))).toBe('1 commit · 0 tasks')
  })

  test('filters by text, bump and environment', () => {
    const all = [deployed, plain]
    const none = { query: '', bumps: [], environments: [] }
    expect(filterVersions(all, none)).toEqual(all)
    expect(filterVersions(all, { ...none, query: 'abc-12' })).toEqual([deployed])
    expect(filterVersions(all, { ...none, query: 'v1.0' })).toEqual([plain])
    expect(filterVersions(all, { ...none, query: 'V1.0.1-SHA' })).toEqual([plain])
    expect(filterVersions(all, { ...none, bumps: ['patch'] })).toEqual([plain])
    expect(filterVersions(all, { ...none, environments: ['staging'] })).toEqual([deployed])
    expect(filterVersions(all, { ...none, environments: ['production'] })).toEqual([])
  })

  test('words the provenance', () => {
    expect(acceptedVia('label')).toBe('by the release-accepted label')
    expect(versionNotesText({ source: 'changelog', edited: false })).toBe(
      'Digest of the changelog · not edited',
    )
    expect(versionNotesText({ source: 'agent', edited: true })).toBe('Written by AI · plan edited')
  })
})
