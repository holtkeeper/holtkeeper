import { describe, expect, test } from 'bun:test'

import { releaseLinks } from './links.ts'
import { actorLabel } from './notify.ts'
import type { ReleaseCommit, ReleaseFacts } from './types.ts'

const commit: ReleaseCommit = {
  sha: 'c1',
  parents: [],
  author: { name: 'Jane', email: 'jane@example.com' },
  date: '2026-11-01T10:00:00Z',
  subject: 'fix: crash',
  body: '',
}

const request = {
  title: 'Release candidate',
  description: '',
  sourceBranch: 'development',
  targetBranch: 'main',
  draft: false,
  labels: [],
  author: 'jane',
}

const facts: ReleaseFacts = {
  repo: { forge: 'work', path: 'acme/shop' },
  webUrl: 'https://git.example.com/acme/shop/',
  defaultBranch: 'main',
  target: { name: 'main', sha: 't1' },
  source: { name: 'development', sha: 's1' },
  versions: [{ tag: 'v1.2.0', version: '1.2.0', sha: 'v1' }],
  latest: { tag: 'v1.2.0', version: '1.2.0', sha: 'v1' },
  ahead: [commit],
  aheadCapped: false,
  unreleased: [commit],
  unreleasedCapped: false,
  request: { ...request, id: 7, state: 'open', webUrl: 'https://git.example.com/mr/7' },
  merged: { ...request, id: 6, state: 'merged', webUrl: 'https://git.example.com/mr/6' },
  pipelines: {
    target: { id: 11, status: 'success', sha: 't1', webUrl: 'https://git.example.com/p/11' },
  },
  blockers: [{ id: 9, title: 'Hold', webUrl: 'https://git.example.com/mr/9', labels: ['hold'] }],
}

describe('release links', () => {
  test('name the release objects first, then the GitLab project pages', () => {
    const links = releaseLinks('gitlab', facts, {
      tag: 'v1.2.0',
      pipeline: { id: 12, status: 'running', sha: 'v1', webUrl: 'https://git.example.com/p/12' },
      environments: [],
    })
    expect(links.filter((link) => link.group === 'current')).toEqual([
      expect.objectContaining({ label: 'Candidate !7', url: 'https://git.example.com/mr/7' }),
      expect.objectContaining({ label: 'Merged !6', url: 'https://git.example.com/mr/6' }),
      expect.objectContaining({ kind: 'blocker', label: 'Blocker !9' }),
      expect.objectContaining({
        kind: 'tag',
        url: 'https://git.example.com/acme/shop/-/tags/v1.2.0',
      }),
      expect.objectContaining({
        label: 'v1.2.0…main',
        url: 'https://git.example.com/acme/shop/-/compare/v1.2.0...main',
      }),
      expect.objectContaining({
        label: 'main…development',
        url: 'https://git.example.com/acme/shop/-/compare/main...development',
      }),
      expect.objectContaining({ label: 'main pipeline', status: 'success' }),
      expect.objectContaining({ label: 'v1.2.0 pipeline', status: 'running' }),
    ])
    expect(links.filter((link) => link.group === 'pages').map((link) => link.url)).toContain(
      'https://git.example.com/acme/shop/-/pipelines',
    )
  })

  test('use GitHub pages and skip what does not wait', () => {
    const links = releaseLinks('github', {
      ...facts,
      unreleased: [],
      ahead: [],
      blockers: [],
      request: undefined,
    })
    expect(links.filter((link) => link.group === 'current').map((link) => link.label)).toEqual([
      'v1.2.0',
      'main pipeline',
    ])
    expect(links.find((link) => link.kind === 'pipelines')).toMatchObject({
      label: 'Actions',
      url: 'https://git.example.com/acme/shop/actions',
    })
  })
})

describe('actor label', () => {
  test('prefers the display name and names the channel', () => {
    expect(actorLabel({ actor: 'u1', actorName: 'Jane Doe', channel: 'slack' })).toBe(
      'Jane Doe (Slack)',
    )
    expect(actorLabel({ actor: 'lead' })).toBe('lead')
  })
})
