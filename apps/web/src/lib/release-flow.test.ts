import { describe, expect, test } from 'bun:test'

import type { FlowDetection, ReleaseSettings, SettingView } from '@holtkeeper/api'

import {
  addEnvironment,
  applyDetection,
  cleanSettings,
  combinedSource,
  draftErrors,
  exampleTag,
  fieldSource,
  firstErrorStep,
  flowStrip,
  repoReleaseEntry,
  signalRows,
  stepOfPath,
  withEnvironment,
} from './release-flow.ts'

const settings = (extra: Partial<ReleaseSettings> = {}): ReleaseSettings => ({
  enabled: false,
  flow: { mode: 'merge-request', source: 'development' },
  version: { scheme: 'semver', tagFormat: 'v{version}', prerelease: false },
  acceptance: 'none',
  changelogFile: false,
  changelog: { excludeTypes: [] },
  mergeRequest: { labels: [] },
  deploy: { environments: [] },
  gates: { pipeline: true, blockingLabels: [] },
  ...extra,
})

const env = (name: string, after?: string) => ({
  name,
  confirm: true,
  ...(after ? { after } : {}),
})

const share = (value: number, sampled: number, where: string) => ({
  share: value,
  matched: Math.round(value * sampled),
  sampled,
  where,
})

const detection = (extra: Partial<FlowDetection> = {}): FlowDetection => ({
  mode: 'merge-request',
  settings: {
    flow: { mode: 'merge-request', source: 'develop' },
    version: { scheme: 'semver', tagFormat: 'v{version}' },
    mergeRequest: { labels: ['release'] },
    changelogFile: true,
    deploy: {
      environments: [
        { name: 'staging', job: 'deploy-staging', confirm: true },
        { name: 'production', job: 'deploy-production', after: 'staging', confirm: true },
      ],
    },
  },
  reasons: ['2 merge request(s) from develop into main'],
  signals: {
    releaseLabels: [{ name: 'release', mergeRequests: 2, of: 2 }],
    changelog: 'CHANGELOG.md',
    conventional: share(0.96, 200, 'commits on main'),
    tracker: { ...share(0.71, 200, 'merged merge requests'), keys: ['ABC'] },
    deployJobs: [
      {
        name: 'deploy-staging',
        stage: 'deploy',
        status: 'success',
        manual: true,
        environment: 'staging',
        ref: 'v1.2.0',
        at: '2026-11-09T10:00:00Z',
      },
      {
        name: 'deploy-production',
        stage: 'deploy',
        status: 'manual',
        manual: true,
        environment: 'production',
        ref: 'v1.2.0',
      },
    ],
    targetBranch: { name: 'main', protected: true },
  },
  provenance: {
    'flow.mode': { kind: 'merge-request', value: '!12', where: 'main', at: '2026-11-09T09:00:00Z' },
    'flow.source': { kind: 'merge-request', value: '!12', where: 'main' },
    'version.scheme': { kind: 'tag', value: 'v1.2.0', where: 'tags' },
    'version.tagFormat': { kind: 'tag', value: 'v1.2.0', where: 'tags' },
    'mergeRequest.labels': { kind: 'label', value: 'release', where: '!12' },
    changelogFile: { kind: 'file', value: 'CHANGELOG.md', where: 'main' },
    'deploy.environments': {
      kind: 'pipeline-job',
      value: 'deploy-staging, deploy-production',
      where: 'v1.2.0',
    },
  },
  ...extra,
})

test('the tag example follows scheme, format and release candidates', () => {
  expect(exampleTag({ scheme: 'semver', tagFormat: 'v{version}', prerelease: false })).toBe(
    'v1.4.0',
  )
  expect(exampleTag({ scheme: 'calver', tagFormat: 'release-{version}', prerelease: true })).toBe(
    'release-2026.11.0-rc.1',
  )
})

test('paths belong to the step that edits them', () => {
  expect(stepOfPath('flow.source')).toBe('flow')
  expect(stepOfPath('gates.blockingLabels')).toBe('flow')
  expect(stepOfPath('acceptance')).toBe('flow')
  expect(stepOfPath('version.tagFormat')).toBe('versions')
  expect(stepOfPath('changelogFile')).toBe('versions')
  expect(stepOfPath('deploy.environments.1.name')).toBe('deploy')
})

describe('applyDetection', () => {
  test('lays the suggestions over the settings, keeping fields they do not name', () => {
    const base = settings({
      flow: { mode: 'trunk', source: 'dev', target: 'stable' },
      version: { scheme: 'calver', tagFormat: '{version}', prerelease: true },
      gates: { pipeline: false, blockingLabels: ['hold'] },
    })
    const next = applyDetection(base, detection())
    expect(next.flow).toEqual({ mode: 'merge-request', source: 'develop' })
    expect(next.version).toEqual({ scheme: 'semver', tagFormat: 'v{version}', prerelease: true })
    expect(next.mergeRequest.labels).toEqual(['release'])
    expect(next.changelogFile).toBe(true)
    expect(next.deploy.environments.map((e) => e.name)).toEqual(['staging', 'production'])
    expect(next.gates).toEqual(base.gates)
  })

  test('suggestions of the wrong shape are ignored', () => {
    const base = settings()
    const next = applyDetection(base, {
      settings: {
        version: { scheme: 'roman', tagFormat: 3 },
        acceptance: 'vote',
        mergeRequest: { labels: [1] },
        deploy: { environments: [{ job: 'x' }, { name: 'qa' }] },
      },
    })
    expect({ ...next, deploy: base.deploy }).toEqual(base)
    expect(next.deploy.environments).toEqual([{ name: 'qa', confirm: true }])
  })

  test('a trunk suggestion keeps the current source branch', () => {
    const next = applyDetection(settings(), { settings: { flow: { mode: 'trunk' } } })
    expect(next.flow).toEqual({ mode: 'trunk', source: 'development' })
  })
})

describe('fieldSource', () => {
  const start = settings()
  const found = detection()

  test('a value equal to an evidenced suggestion is detected', () => {
    const draft = applyDetection(start, found)
    const context = { draft, start, detection: found, configured: false }
    expect(fieldSource('flow.source', context)).toBe('detected')
    expect(fieldSource('deploy.environments', context)).toBe('detected')
    expect(fieldSource('gates.pipeline', context)).toBe('default')
  })

  test('a changed value is edited, an untouched one saved or default', () => {
    const draft = { ...start, acceptance: 'manual' as const }
    expect(fieldSource('acceptance', { draft, start, configured: true })).toBe('edited')
    expect(fieldSource('flow.source', { draft, start, configured: true })).toBe('saved')
    expect(fieldSource('flow.source', { draft, start, configured: false })).toBe('default')
    const changed = {
      ...applyDetection(start, found),
      flow: { mode: 'trunk' as const, source: 'x' },
    }
    expect(
      fieldSource('flow.source', { draft: changed, start, detection: found, configured: false }),
    ).toBe('edited')
  })

  test('several fields read as edited first, then detected', () => {
    expect(combinedSource(['saved', 'detected'])).toBe('detected')
    expect(combinedSource(['detected', 'edited'])).toBe('edited')
    expect(combinedSource(['default', 'saved'])).toBe('saved')
    expect(combinedSource([])).toBe('default')
  })
})

describe('draft checks', () => {
  test('names what blocks saving and the first step to fix', () => {
    const draft = settings({
      flow: { mode: 'merge-request', source: ' ', target: 'main' },
      version: { scheme: 'semver', tagFormat: 'v', prerelease: false },
      deploy: { environments: [env('staging'), env(''), env('staging')] },
    })
    const errors = draftErrors(draft)
    expect(errors).toEqual({
      'flow.source': 'Required',
      'version.tagFormat': 'Must contain {version}',
      'deploy.environments.1.name': 'Required',
      'deploy.environments.2.name': 'Another environment has this name',
    })
    expect(firstErrorStep(errors)).toBe('flow')
    expect(firstErrorStep({ 'deploy.environments.0.name': 'Required' })).toBe('deploy')
    expect(firstErrorStep({})).toBeUndefined()
  })

  test('the target must differ from the source; trunk mode has no source', () => {
    const same = settings({ flow: { mode: 'merge-request', source: 'main', target: 'main' } })
    expect(draftErrors(same)).toEqual({ 'flow.target': 'Must differ from the source branch' })
    expect(draftErrors({ ...same, flow: { mode: 'trunk', source: '' } })).toEqual({})
  })

  test('saving trims and drops empty optional fields and dangling afters', () => {
    const draft = settings({
      flow: { mode: 'merge-request', source: ' develop ', target: '  ' },
      changelog: { excludeTypes: ['ci'], ticketUrl: ' ' },
      deploy: {
        environments: [
          { name: ' staging ', job: ' ', confirm: true },
          { name: 'production', job: 'ship', after: 'gone', confirm: false },
          { name: 'dr', after: 'production', confirm: true },
        ],
      },
    })
    const clean = cleanSettings(draft)
    expect(clean.flow).toEqual({ mode: 'merge-request', source: 'develop' })
    expect(clean.changelog).toEqual({ excludeTypes: ['ci'] })
    expect(clean.deploy.environments).toEqual([
      { name: 'staging', confirm: true },
      { name: 'production', job: 'ship', confirm: false },
      { name: 'dr', after: 'production', confirm: true },
    ])
  })
})

describe('environment edits', () => {
  const three = settings({
    deploy: { environments: [env('staging'), env('prod', 'staging'), env('dr', 'prod')] },
  })

  test('renaming carries over to the environments deployed after it', () => {
    const next = withEnvironment(three, 0, env('qa'))
    expect(next.deploy.environments).toEqual([env('qa'), env('prod', 'qa'), env('dr', 'prod')])
  })

  test('removing drops the afters that named it', () => {
    const next = withEnvironment(three, 1, undefined)
    expect(next.deploy.environments).toEqual([env('staging'), env('dr')])
    expect(withEnvironment(three, 9, undefined)).toBe(three)
  })

  test('adding names the common environments first and deploys after the last', () => {
    const one = addEnvironment(settings())
    expect(one.deploy.environments).toEqual([env('staging')])
    const two = addEnvironment(one)
    expect(two.deploy.environments.at(-1)).toEqual(env('production', 'staging'))
    expect(addEnvironment(two).deploy.environments.at(-1)?.name).toBe('environment-3')
    const gap = settings({
      deploy: { environments: [env('staging'), env('production'), env('environment-4')] },
    })
    expect(addEnvironment(gap).deploy.environments.at(-1)).toEqual(
      env('environment-5', 'environment-4'),
    )
  })
})

const shape = (groups: ReturnType<typeof flowStrip>) =>
  groups.map((group) => `${group.label}: ${group.items.map((item) => item.title).join(' > ')}`)

describe('flowStrip', () => {
  test('merge request mode shows source, release MR and target, then the tag and environments', () => {
    const groups = flowStrip(
      settings({
        mergeRequest: { labels: ['release'] },
        acceptance: 'merge',
        gates: { pipeline: true, blockingLabels: ['hold'] },
        deploy: {
          environments: [
            { name: 'staging', job: 'deploy-staging', confirm: false },
            env('prod', 'staging'),
          ],
        },
      }),
      'main',
    )
    expect(shape(groups)).toEqual([
      'Branches: development > Release MR > main',
      'Tags: v1.4.0',
      'Environments: staging > prod',
    ])
    const [branches, tags, environments] = groups
    expect(branches?.items.map((item) => item.detail)).toEqual([
      'source',
      'label release · accepted by merging',
      'target · 2 gates',
    ])
    expect(tags?.items[0]).toMatchObject({ step: 'versions', detail: 'semantic · v{version}' })
    expect(environments?.items.map((item) => item.detail)).toEqual([
      'deploy-staging · right after the tag',
      'prod · after staging · asks first',
    ])
  })

  test('trunk mode starts at the target, external mode has no tag', () => {
    const trunk = flowStrip(
      settings({
        flow: { mode: 'trunk', source: 'development', target: 'trunk' },
        acceptance: 'manual',
        gates: { pipeline: false, blockingLabels: [] },
      }),
    )
    expect(shape(trunk)).toEqual(['Branches: trunk', 'Tags: v1.4.0', 'Environments: '])
    expect(trunk[0]?.items[0]?.detail).toBe('trunk · accepted by a person · 0 gates')
    const external = flowStrip(settings({ flow: { mode: 'external', source: 'development' } }))
    expect(shape(external)).toEqual(['Branches: External tool', 'Environments: '])
  })
})

test('signal rows list every piece of evidence with what it suggests', () => {
  const rows = signalRows(detection())
  expect(rows.map((row) => [row.kind, row.what, row.where, row.suggests])).toEqual([
    ['tag', 'v1.2.0', 'tags', ['Scheme: semantic', 'Tag format: v{version}']],
    ['merge-request', '!12', 'main', ['Flow: Release merge request', 'Source branch: develop']],
    ['label', 'release', 'labels', ['Release MR labels: release']],
    ['file', 'CHANGELOG.md', 'main', ['CHANGELOG.md: prepend the notes']],
    ['commits', '96%', 'commits on main', []],
    ['commits', '71%', 'merged merge requests', []],
    ['pipeline-job', 'deploy-staging', 'v1.2.0', ['Environment: staging']],
    ['pipeline-job', 'deploy-production', 'v1.2.0', ['Environment: production']],
    ['branch', 'main', 'branches', []],
  ])
  expect(rows[1]?.at).toBe('2026-11-09T09:00:00Z')
  expect(rows[5]?.note).toBe('of 200 merged merge requests carry a tracker key (ABC)')
  expect(rows[6]?.note).toBe('manual, stage deploy')
})

test('commit share evidence backs the scheme when no tags exist', () => {
  const found = detection({
    settings: { flow: { mode: 'trunk' }, version: { scheme: 'semver', tagFormat: 'v{version}' } },
    signals: { ...detection().signals, deployJobs: [], releaseLabels: [] },
    provenance: {
      'flow.mode': { kind: 'branch', value: 'main', where: 'branches' },
      'version.scheme': { kind: 'commits', value: '96%', where: 'commits on main' },
      'gates.pipeline': { kind: 'branch', value: 'main', where: 'branches' },
    },
  })
  found.settings['gates'] = { pipeline: true }
  const rows = signalRows(found)
  expect(rows.find((row) => row.kind === 'commits')?.suggests).toEqual(['Scheme: semantic'])
  expect(rows.find((row) => row.kind === 'branch')?.suggests).toEqual([
    'Flow: Trunk',
    'Pipeline gate: a failed pipeline blocks',
  ])
})

const entry = (id: string, scope: SettingView['scope'], key = 'releases'): SettingView => ({
  id,
  key,
  scope,
  value: {},
  secret: false,
  updatedAt: '2026-01-01T00:00:00Z',
})

test('finds the setting that names exactly this repository', () => {
  const repo = { forge: 'w', path: 'acme/widgets' }
  const entries = [
    entry('all', { all: true }),
    entry('group', { groups: ['acme'] }),
    entry('two', { repos: ['w:acme/widgets', 'w:acme/gadgets'] }),
    entry('other', { repos: ['w:acme/widgets'] }, 'review'),
    entry('own', { repos: ['acme/widgets'] }),
  ]
  expect(repoReleaseEntry(entries, repo)?.id).toBe('own')
  expect(repoReleaseEntry(entries.slice(0, 4), repo)).toBeUndefined()
  expect(repoReleaseEntry(undefined, repo)).toBeUndefined()
})
