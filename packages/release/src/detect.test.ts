import { describe, expect, test } from 'bun:test'

import type { GitForge, PipelineJob } from '@holtkeeper/forge'

import {
  detectFlow,
  detectRepositoryFlow,
  type DetectionInput,
  type DetectionSource,
} from './detect.ts'

const job = (
  id: number,
  name: string,
  stage: string,
  extra: Partial<PipelineJob> = {},
): PipelineJob => ({
  id,
  name,
  stage,
  status: 'success',
  webUrl: `https://forge.example.com/acme/widget/-/jobs/${id}`,
  pipelineId: 7,
  manual: false,
  ...extra,
})

const releaseInput: DetectionInput = {
  defaultBranch: 'main',
  branches: [
    { name: 'main', protected: true },
    { name: 'develop', protected: false },
  ],
  tags: [
    { name: 'v1.2.0', committedAt: '2026-10-20T10:00:00Z' },
    { name: 'v1.1.4', committedAt: '2026-10-06T10:00:00Z' },
  ],
  merged: [
    {
      id: 31,
      title: 'Release 1.2.0',
      sourceBranch: 'develop',
      targetBranch: 'main',
      labels: ['release', 'release-accepted'],
      mergedAt: '2026-10-20T09:00:00Z',
    },
    {
      id: 29,
      title: 'feat(cart): ABC-12 add totals',
      sourceBranch: 'feature/ABC-12-totals',
      targetBranch: 'develop',
      labels: [],
      mergedAt: '2026-10-18T09:00:00Z',
    },
    {
      id: 19,
      title: 'Release 1.1.4',
      sourceBranch: 'develop',
      targetBranch: 'main',
      labels: ['release'],
      mergedAt: '2026-10-06T09:00:00Z',
    },
  ],
  files: ['package.json', 'CHANGELOG.md'],
  commits: {
    ref: 'main',
    titles: [
      'feat(cart): add totals',
      'fix: ABC-14 round prices',
      "Merge branch 'develop' into 'main'",
      'update readme',
    ],
  },
  pipeline: {
    ref: 'v1.2.0',
    jobs: [
      job(1, 'build', 'build'),
      job(2, 'deploy-staging', 'deploy', {
        manual: true,
        environment: 'staging',
        finishedAt: '2026-10-20T11:00:00Z',
      }),
      job(3, 'deploy:production', 'deploy', {
        status: 'manual',
        manual: true,
        createdAt: '2026-10-20T10:01:00Z',
      }),
    ],
  },
}

describe('detectFlow signals', () => {
  test('reads labels, changelog, shares, deploy jobs and protection', () => {
    const { signals } = detectFlow(releaseInput)
    expect(signals.releaseLabels).toEqual([
      { name: 'release', mergeRequests: 2, of: 2 },
      { name: 'release-accepted', mergeRequests: 1, of: 2 },
    ])
    expect(signals.changelog).toBe('CHANGELOG.md')
    expect(signals.conventional).toEqual({
      share: 2 / 3,
      matched: 2,
      sampled: 3,
      where: 'commits on main',
    })
    expect(signals.tracker).toEqual({
      share: 1 / 3,
      matched: 1,
      sampled: 3,
      where: 'merged merge requests',
      keys: ['ABC'],
    })
    expect(signals.deployJobs).toEqual([
      {
        name: 'deploy-staging',
        stage: 'deploy',
        status: 'success',
        manual: true,
        environment: 'staging',
        ref: 'v1.2.0',
        at: '2026-10-20T11:00:00Z',
      },
      {
        name: 'deploy:production',
        stage: 'deploy',
        status: 'manual',
        manual: true,
        environment: 'production',
        ref: 'v1.2.0',
        at: '2026-10-20T10:01:00Z',
      },
    ])
    expect(signals.targetBranch).toEqual({ name: 'main', protected: true })
  })

  test('falls back to merge request titles and commit titles when one side is missing', () => {
    const { signals } = detectFlow({
      defaultBranch: 'main',
      branches: [{ name: 'main' }],
      tags: [],
      merged: [{ sourceBranch: 'fix/ABC-3', targetBranch: 'main', title: 'fix: crash' }],
      files: [],
    })
    expect(signals.conventional).toMatchObject({
      matched: 1,
      sampled: 1,
      where: 'merged merge requests',
    })
    expect(signals.tracker).toMatchObject({ matched: 1, sampled: 1, keys: ['ABC'] })
    expect(signals.targetBranch).toBeUndefined()
    expect(signals.changelog).toBeUndefined()

    const fromCommits = detectFlow({
      defaultBranch: 'main',
      branches: [],
      tags: [],
      merged: [],
      files: [],
      commits: { ref: 'main', titles: ['XYZ-9 tidy up', 'UTF-8 everywhere'] },
    }).signals
    expect(fromCommits.tracker).toMatchObject({ matched: 1, sampled: 2, where: 'commits on main' })
    expect(fromCommits.conventional.share).toBe(0)
  })

  test('only release-like labels count when there is no release merge request flow', () => {
    const { signals, settings } = detectFlow({
      defaultBranch: 'main',
      branches: [{ name: 'main' }],
      tags: [],
      merged: [
        { sourceBranch: 'a', targetBranch: 'main', labels: ['release-note', 'ui'] },
        { sourceBranch: 'b', targetBranch: 'main', labels: ['ui'] },
      ],
      files: [],
    })
    expect(signals.releaseLabels).toEqual([{ name: 'release-note', mergeRequests: 1, of: 2 }])
    expect(settings['mergeRequest']).toBeUndefined()
  })

  test('jobs without an environment count as deploys by name or stage', () => {
    const { signals } = detectFlow({
      defaultBranch: 'main',
      branches: [],
      tags: [],
      merged: [],
      files: [],
      pipeline: {
        ref: 'main',
        jobs: [
          job(1, 'test', 'test'),
          job(2, 'ship', 'deploy'),
          job(3, 'rollout_canary', 'release'),
          job(4, 'deploy', 'release'),
        ],
      },
    })
    expect(signals.deployJobs.map((j) => [j.name, j.environment])).toEqual([
      ['ship', 'ship'],
      ['rollout_canary', 'canary'],
      ['deploy', 'deploy'],
    ])
  })
})

describe('detectFlow settings and provenance', () => {
  test('suggests settings from each signal and says where each came from', () => {
    const detected = detectFlow(releaseInput)
    expect(detected.mode).toBe('merge-request')
    expect(detected.settings).toEqual({
      flow: { mode: 'merge-request', source: 'develop' },
      version: { scheme: 'semver', tagFormat: 'v{version}' },
      mergeRequest: { labels: ['release'] },
      acceptance: 'label',
      changelogFile: true,
      deploy: {
        environments: [
          { name: 'staging', job: 'deploy-staging', confirm: true },
          { name: 'production', job: 'deploy:production', after: 'staging', confirm: true },
        ],
      },
      gates: { pipeline: true },
    })
    const release: DetectionSource = {
      kind: 'merge-request',
      value: '!31',
      where: 'main',
      at: '2026-10-20T09:00:00Z',
    }
    const tag: DetectionSource = {
      kind: 'tag',
      value: 'v1.2.0',
      where: 'tags',
      at: '2026-10-20T10:00:00Z',
    }
    expect(detected.provenance).toEqual({
      'flow.mode': release,
      'flow.source': release,
      'version.scheme': tag,
      'version.tagFormat': tag,
      'mergeRequest.labels': {
        kind: 'label',
        value: 'release',
        where: '!31',
        at: '2026-10-20T09:00:00Z',
      },
      acceptance: {
        kind: 'label',
        value: 'release-accepted',
        where: '!31',
        at: '2026-10-20T09:00:00Z',
      },
      changelogFile: { kind: 'file', value: 'CHANGELOG.md', where: 'main' },
      'deploy.environments': {
        kind: 'pipeline-job',
        value: 'deploy-staging, deploy:production',
        where: 'v1.2.0',
        at: '2026-10-20T11:00:00Z',
      },
      'gates.pipeline': { kind: 'branch', value: 'main', where: 'branches' },
    })
    expect(detected.reasons[0]).toBe('2 merge request(s) from develop into main')
    expect(detected.reasons).toContain('67% of 3 commits on main follow Conventional Commits')
  })

  test('a release target other than the default branch has its own provenance', () => {
    const detected = detectFlow({
      defaultBranch: 'develop',
      branches: [{ name: 'develop' }, { name: 'stable', protected: false }],
      tags: [],
      merged: [{ id: 4, sourceBranch: 'develop', targetBranch: 'stable' }],
      files: [],
    })
    expect(detected.settings['flow']).toEqual({
      mode: 'merge-request',
      source: 'develop',
      target: 'stable',
    })
    expect(detected.provenance['flow.target']).toEqual({
      kind: 'merge-request',
      value: '!4',
      where: 'stable',
    })
    expect(detected.signals.targetBranch).toEqual({ name: 'stable', protected: false })
    expect(detected.settings['gates']).toBeUndefined()
  })

  test('defaults keep no provenance; conventional commits back the scheme without tags', () => {
    const detected = detectFlow({
      defaultBranch: 'main',
      branches: [{ name: 'main' }],
      tags: [],
      merged: [],
      files: [],
      commits: { ref: 'main', titles: ['feat: a', 'fix: b'] },
    })
    expect(detected.settings).toEqual({
      flow: { mode: 'trunk' },
      version: { scheme: 'semver', tagFormat: 'v{version}' },
    })
    expect(detected.provenance).toEqual({
      'flow.mode': { kind: 'branch', value: 'main', where: 'branches' },
      'version.scheme': { kind: 'commits', value: '100%', where: 'commits on main' },
    })
  })

  test('external tools still report signals', () => {
    const detected = detectFlow({
      defaultBranch: 'main',
      branches: [],
      tags: [{ name: '@acme/widget@2.0.0', committedAt: '2026-10-01T00:00:00Z' }],
      merged: [],
      files: ['CHANGELOG.md'],
    })
    expect(detected.mode).toBe('external')
    expect(detected.settings).toEqual({ flow: { mode: 'external' } })
    expect(detected.provenance).toEqual({
      'flow.mode': {
        kind: 'tag',
        value: '@acme/widget@2.0.0',
        where: 'tags',
        at: '2026-10-01T00:00:00Z',
      },
    })
    expect(detected.signals.changelog).toBe('CHANGELOG.md')
  })

  test('a .changeset folder means external', () => {
    const detected = detectFlow({
      defaultBranch: 'main',
      branches: [{ name: 'main' }],
      tags: [{ name: 'v1.0.0', committedAt: '2026-10-01T00:00:00Z' }],
      merged: [],
      files: ['.changeset', 'package.json'],
    })
    expect(detected.mode).toBe('external')
    expect(detected.provenance['flow.mode']).toEqual({
      kind: 'file',
      value: '.changeset',
      where: 'main',
    })
  })

  test('calendar version tags suggest calver', () => {
    const detected = detectFlow({
      defaultBranch: 'main',
      branches: [{ name: 'main' }],
      tags: [
        { name: '2026.10.2', committedAt: '2026-10-20T00:00:00Z' },
        { name: '2026.10.1', committedAt: '2026-10-10T00:00:00Z' },
      ],
      merged: [],
      files: [],
    })
    expect(detected.mode).toBe('trunk')
    expect(detected.settings['version']).toEqual({ scheme: 'calver', tagFormat: '{version}' })
  })
})

describe('detectRepositoryFlow', () => {
  const repo = { forge: 'acme', path: 'acme/widget' }
  const base = {
    kind: 'fake',
    getRepository: async () => ({
      path: 'acme/widget',
      name: 'widget',
      defaultBranch: 'main',
      webUrl: '',
      cloneUrl: '',
      archived: false,
    }),
  }
  const fake = (methods: Partial<GitForge>) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the reads detection uses
    ({ ...base, ...methods }) as unknown as GitForge

  test('a forge with only getRepository detects trunk with empty signals', async () => {
    const detected = await detectRepositoryFlow(fake({}), repo)
    expect(detected.mode).toBe('trunk')
    expect(detected.signals).toEqual({
      releaseLabels: [],
      conventional: { share: 0, matched: 0, sampled: 0, where: 'merged merge requests' },
      tracker: { share: 0, matched: 0, sampled: 0, where: 'commits on main', keys: [] },
      deployJobs: [],
    })
  })

  test('reads the newest tag pipeline, then the default branch when it has no deploy jobs', async () => {
    const refs: (string | undefined)[] = []
    const detected = await detectRepositoryFlow(
      fake({
        listTags: async () => [{ name: 'v2.0.0', sha: 'a', committedAt: '2026-10-01T00:00:00Z' }],
        listBranches: async () => {
          throw new Error('denied')
        },
        listCommits: async (_repo, query) => {
          expect(query).toEqual({ ref: 'main', limit: 200 })
          return [
            {
              sha: 'a',
              parents: [],
              authorName: 'Ann',
              authorEmail: 'ann@example.com',
              authoredAt: '2026-10-01T00:00:00Z',
              title: 'feat: widgets',
              message: 'feat: widgets',
            },
          ]
        },
        listPipelineJobs: async (_repo, query) => {
          refs.push(query?.ref)
          return query?.ref === 'main'
            ? [job(5, 'deploy-qa', 'deploy', { manual: true })]
            : [job(4, 'build', 'build')]
        },
      }),
      repo,
    )
    expect(refs).toEqual(['v2.0.0', 'main'])
    expect(detected.signals.deployJobs.map((j) => [j.environment, j.ref])).toEqual([['qa', 'main']])
    expect(detected.signals.conventional).toMatchObject({ matched: 1, where: 'commits on main' })
    expect(detected.provenance['version.scheme']).toMatchObject({ value: 'v2.0.0' })
  })

  test('a tag pipeline with deploy jobs is used as is', async () => {
    const refs: (string | undefined)[] = []
    const detected = await detectRepositoryFlow(
      fake({
        listTags: async () => [{ name: 'v2.0.0', sha: 'a', committedAt: '2026-10-01T00:00:00Z' }],
        listPipelineJobs: async (_repo, query) => {
          refs.push(query?.ref)
          return [job(6, 'deploy-prod', 'deploy', { environment: 'prod' })]
        },
      }),
      repo,
    )
    expect(refs).toEqual(['v2.0.0'])
    expect(detected.settings['deploy']).toEqual({
      environments: [{ name: 'prod', job: 'deploy-prod', confirm: false }],
    })
  })
})
