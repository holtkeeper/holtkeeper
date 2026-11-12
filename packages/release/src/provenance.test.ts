import { describe, expect, test } from 'bun:test'

import { environmentSummaries, withDeployActors } from './deploy.ts'
import { versionProvenance } from './provenance.ts'
import { releaseSettings } from './settings.ts'
import type { DeployState, ReleaseEvent } from './types.ts'

const repo = { forge: 'work', path: 'g/widget' }

const event = (
  kind: ReleaseEvent['kind'],
  at: string,
  extra: Partial<ReleaseEvent> = {},
): ReleaseEvent => ({ kind, repo, at, actor: 'header:ada', ...extra })

describe('version provenance', () => {
  const history = [
    event('deploy-started', '2026-11-05T14:00:00.000Z', { tag: 'v4.2.1', environment: 'staging' }),
    event('versioned', '2026-11-05T13:50:00.000Z', {
      tag: 'v4.2.1',
      sha: 'c2',
      actorName: 'Ada',
      channel: 'ui',
      force: false,
      notes: { source: 'changelog', edited: false },
      changelogSha: 'c3',
      url: 'https://forge.example.com/g/widget/-/releases/v4.2.1',
    }),
    event('accepted', '2026-11-05T13:40:00.000Z', {
      actor: 'header:teo',
      sha: 'c2',
      via: 'manual',
      channel: 'ui',
      note: 'Hotfix before the launch',
      detail: 'Hotfix before the launch',
    }),
    event('accepted', '2026-11-05T12:00:00.000Z', { actor: 'header:old', sha: 'c1' }),
    event('versioned', '2026-10-28T10:00:00.000Z', { tag: 'v4.2.0', sha: 'b9' }),
    event('accepted', '2026-10-28T09:00:00.000Z', { actor: 'header:bo', detail: 'QA passed' }),
  ]

  test('pairs the version with the acceptance of the same commit', () => {
    expect(versionProvenance(history, 'v4.2.1')).toEqual({
      accepted: {
        actor: 'header:teo',
        channel: 'ui',
        at: '2026-11-05T13:40:00.000Z',
        via: 'manual',
        note: 'Hotfix before the launch',
        sha: 'c2',
      },
      versioned: {
        actor: 'header:ada',
        actorName: 'Ada',
        channel: 'ui',
        at: '2026-11-05T13:50:00.000Z',
        force: false,
        notes: { source: 'changelog', edited: false },
        changelogSha: 'c3',
        url: 'https://forge.example.com/g/widget/-/releases/v4.2.1',
      },
    })
  })

  test('reads older events without the new fields and stops at the previous version', () => {
    expect(versionProvenance(history, 'v4.2.0')).toEqual({
      accepted: { actor: 'header:bo', at: '2026-10-28T09:00:00.000Z', note: 'QA passed' },
      versioned: { actor: 'header:ada', at: '2026-10-28T10:00:00.000Z', force: false },
    })
    expect(
      versionProvenance(
        [event('versioned', '2026-11-02T00:00:00.000Z', { tag: 'v2.0.0' }), ...history.slice(4)],
        'v2.0.0',
      ),
    ).toEqual({ versioned: { actor: 'header:ada', at: '2026-11-02T00:00:00.000Z', force: false } })
    expect(versionProvenance(history, 'v1.0.0')).toBeUndefined()
  })
})

describe('deploy state', () => {
  const settings = releaseSettings({
    deploy: {
      environments: [{ name: 'staging' }, { name: 'production', after: 'staging' }, { name: 'qa' }],
    },
  })
  const state: DeployState = {
    tag: 'v4.2.1',
    pipeline: { id: 1, status: 'success', sha: 'c3', webUrl: 'https://p/1' },
    environments: [
      {
        name: 'staging',
        status: 'success',
        confirm: true,
        attempts: [
          {
            jobId: 12,
            status: 'success',
            webUrl: 'https://j/12',
            finishedAt: '2026-11-05T14:12:00Z',
          },
          { jobId: 11, status: 'failed', webUrl: 'https://j/11' },
        ],
      },
      {
        name: 'production',
        status: 'ready',
        confirm: true,
        after: 'staging',
        attempts: [{ jobId: 13, status: 'manual', webUrl: 'https://j/13' }],
        current: { ref: 'v4.2.0', sha: 'b9', status: 'success', at: '2026-10-28T11:00:00Z' },
      },
    ],
  }

  test('marks the attempts Holtkeeper started with who and why', () => {
    const marked = withDeployActors(state, [
      event('deploy-started', '2026-11-05T14:09:00Z', {
        tag: 'v4.2.1',
        environment: 'staging',
        jobId: 12,
        actorName: 'Ada',
        reason: 'redeploy',
      }),
      event('deploy-started', '2026-11-05T13:58:00Z', {
        tag: 'v4.2.0',
        environment: 'staging',
        jobId: 11,
      }),
    ])
    expect(marked.environments[0]?.attempts).toEqual([
      expect.objectContaining({
        jobId: 12,
        actor: 'header:ada',
        actorName: 'Ada',
        reason: 'redeploy',
      }),
      { jobId: 11, status: 'failed', webUrl: 'https://j/11' },
    ])
    expect(withDeployActors(state, [])).toBe(state)
  })

  test('summarizes the version on each configured environment', () => {
    expect(environmentSummaries(settings, state)).toEqual([
      {
        name: 'staging',
        tag: 'v4.2.1',
        version: '4.2.1',
        status: 'success',
        at: '2026-11-05T14:12:00Z',
      },
      {
        name: 'production',
        tag: 'v4.2.0',
        version: '4.2.0',
        status: 'ready',
        at: '2026-10-28T11:00:00Z',
      },
      { name: 'qa', status: 'no-pipeline' },
    ])
    expect(environmentSummaries(settings, undefined).map((env) => env.status)).toEqual([
      'no-pipeline',
      'no-pipeline',
      'no-pipeline',
    ])
  })
})
