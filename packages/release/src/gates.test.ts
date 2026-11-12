import { describe, expect, test } from 'bun:test'

import { checkGates, gatesPass } from './gates.ts'
import { blockingGates, planRelease } from './plan.ts'
import { releaseSettings } from './settings.ts'
import { prependChangelog } from './steps.ts'
import type { GateResult, ReleaseCommit, ReleaseFacts } from './types.ts'

describe('settings', () => {
  test('default to off and parse an empty value', () => {
    const settings = releaseSettings()
    expect(settings.enabled).toBe(false)
    expect(settings.acceptance).toBe('none')
    expect(settings.gates.pipeline).toBe(true)
  })

  test('drop fields a stored row of an older shape breaks, keep the rest', () => {
    const settings = releaseSettings({
      enabled: true,
      flow: { mode: 'trunk' },
      version: { tagFormat: 'release-{version}', prerelease: 'rc', bump: { minimum: 'minor' } },
      acceptance: { required: true, signals: ['label'] },
      gates: { pipeline: 'success', freeze: [{ days: ['fri'] }], blockingLabels: ['hold'] },
      deploy: { environments: [{ name: 'prod', auto: true }, { job: 'nameless' }] },
      summary: { mode: 'agent' },
      timezone: 'Europe/Berlin',
    })
    expect(settings).toEqual({
      enabled: true,
      flow: { mode: 'trunk', source: 'development' },
      version: { scheme: 'semver', tagFormat: 'release-{version}', prerelease: false },
      acceptance: 'none',
      changelogFile: false,
      changelog: { excludeTypes: [] },
      mergeRequest: { labels: [] },
      deploy: { environments: [{ name: 'prod', confirm: true }] },
      gates: { pipeline: true, blockingLabels: ['hold'] },
    })
  })

  test('drop only the broken elements of a list', () => {
    const settings = releaseSettings({
      mergeRequest: { labels: [1, 'b', 2, 'd'] },
      deploy: { environments: [{ name: '' }, { name: 'b' }, { name: '' }, { name: 'd' }] },
    })
    expect(settings.mergeRequest.labels).toEqual(['b', 'd'])
    expect(settings.deploy.environments.map((environment) => environment.name)).toEqual(['b', 'd'])
  })

  test('survive values that are not objects', () => {
    expect(releaseSettings('nope').enabled).toBe(false)
    expect(releaseSettings({ flow: 'trunk' }).flow.mode).toBe('merge-request')
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

const commit = (sha: string, subject: string): ReleaseCommit => ({
  sha,
  parents: [],
  author: { name: 'Ada', email: 'ada@example.com' },
  date: '2026-10-30T10:00:00.000Z',
  subject,
  body: '',
})

const factsWith = (patch: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  repo: { forge: 'work', path: 'g/widget' },
  webUrl: 'https://forge.example.com/g/widget',
  defaultBranch: 'main',
  target: { name: 'main', sha: 'b2' },
  versions: [],
  ahead: [],
  aheadCapped: false,
  unreleased: [commit('b2', 'feat: [ABC-1] round widgets')],
  unreleasedCapped: false,
  pipelines: {},
  blockers: [],
  ...patch,
})

const byId = (gates: GateResult[]) => Object.fromEntries(gates.map((gate) => [gate.id, gate]))

describe('gate severity', () => {
  const settings = releaseSettings({
    enabled: true,
    flow: { mode: 'trunk' },
    acceptance: 'manual',
    gates: { blockingLabels: ['hold'] },
  })

  test('a missing pipeline only informs, failures block', () => {
    expect(byId(checkGates('version', settings, factsWith()))['pipeline']).toEqual({
      id: 'pipeline',
      ok: true,
      severity: 'info',
      message: 'main has no pipeline',
    })
    const gates = checkGates(
      'version',
      settings,
      factsWith({
        pipelines: { target: { id: 1, status: 'failed', sha: 'b2', webUrl: 'https://p/1' } },
        blockers: [{ id: 7, title: 'Hold it', webUrl: 'https://mr/7', labels: ['hold'] }],
      }),
    )
    expect(gates.map((gate) => [gate.id, gate.ok, gate.severity])).toEqual([
      ['pipeline', false, 'block'],
      ['blockers', false, 'block'],
      ['acceptance', false, 'block'],
    ])
    expect(gatesPass(gates)).toBe(false)
  })

  test('a changelog of commits without conventions warns but never blocks', () => {
    const plan = planRelease({
      step: 'version',
      facts: factsWith({
        unreleased: [commit('b2', 'round widgets'), commit('b1', 'feat: square widgets')],
        acceptance: { sha: 'b2', by: 'ada', at: '2026-10-31T10:00:00.000Z', via: 'manual' },
      }),
      settings,
      now: new Date('2026-11-01T09:00:00.000Z'),
    })
    expect(byId(plan.gates)['changelog']).toEqual({
      id: 'changelog',
      ok: false,
      severity: 'warn',
      message: '1 of 2 entries are not conventional commits',
    })
    expect(blockingGates(plan.gates, false)).toEqual([])
    expect(gatesPass(plan.gates)).toBe(true)
  })

  test('a conventional changelog is ready, hard gates block even with force', () => {
    const plan = planRelease({
      step: 'version',
      facts: factsWith(),
      settings,
      edits: { version: 'nope' },
      now: new Date('2026-11-01T09:00:00.000Z'),
    })
    expect(byId(plan.gates)['changelog']).toMatchObject({
      ok: true,
      message: 'changelog ready: 1 entries',
    })
    expect(blockingGates(plan.gates, true).map((gate) => gate.id)).toEqual(['tag-exists'])
    expect(blockingGates(plan.gates, false).map((gate) => gate.id)).toEqual([
      'acceptance',
      'tag-exists',
    ])
  })
})
