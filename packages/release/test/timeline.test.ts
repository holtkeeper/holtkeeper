import { describe, expect, test } from 'bun:test'

import {
  type RangeCache,
  collectRangeFacts,
  forgeLinks,
  rangeKey,
  releaseSettings,
  releaseTasks,
  versionDetail,
  versionTags,
  versionTimeline,
} from '../src/index.ts'
import { FakeForge } from '../src/testing.ts'

const repo = { forge: 'work', path: 'g/app' }
const settings = releaseSettings({ enabled: true })
const links = forgeLinks({
  kind: 'gitlab',
  webUrl: 'https://forge/g/app',
  ticketUrl: 'https://tracker.example.com/browse/{id}',
})

function memoryCache(): RangeCache & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
  }
}

function history() {
  const fake = new FakeForge()
  fake.commitTo('main', 'feat: ABC-1 widget list')
  fake.tag('v1.0.0')
  fake.commitTo('main', 'fix: [ABC-2] keep the order', 'chore: tidy')
  fake.tag('v1.0.1-rc.1')
  fake.commitTo('feature/ABC-3-shapes', 'feat: circles', 'feat(shapes): squares')
  fake.merge('feature/ABC-3-shapes', 'main', "Merge branch 'feature/ABC-3-shapes' into 'main'")
  fake.tag('v1.1.0')
  fake.commitTo('main', 'feat!: drop the old widget api')
  fake.tag('v2.0.0')
  return fake
}

const tagsOf = async (fake: FakeForge) =>
  versionTags(settings, await fake.forge.listTags!(fake.repo, { limit: 100 }))

describe('version timeline', () => {
  test('lists versions newest first with counts, tasks and bumps, skipping candidates', async () => {
    const fake = history()
    const page = await versionTimeline({
      forge: fake.forge,
      repo,
      settings,
      versions: await tagsOf(fake),
      limit: 2,
      links,
    })
    expect(page.total).toBe(3)
    expect(page.nextOffset).toBe(2)
    expect(page.versions.map((v) => [v.tag, v.previous, v.commitCount, v.bump, v.tickets])).toEqual(
      [
        ['v2.0.0', 'v1.1.0', 1, 'major', []],
        ['v1.1.0', 'v1.0.0', 5, 'minor', ['ABC-3', 'ABC-2']],
      ],
    )

    const rest = await versionTimeline({
      forge: fake.forge,
      repo,
      settings,
      versions: await tagsOf(fake),
      offset: 2,
    })
    expect(rest.nextOffset).toBeUndefined()
    expect(rest.versions.map((v) => [v.tag, v.previous, v.commitCount])).toEqual([
      ['v1.0.0', undefined, 2],
    ])
  })

  test('leaves out the oldest version of an incomplete tag list', async () => {
    const fake = history()
    const options = {
      forge: fake.forge,
      repo,
      settings,
      versions: await tagsOf(fake),
      complete: false,
    }
    const page = await versionTimeline(options)
    expect(page.total).toBe(2)
    expect(page.versions.map((v) => [v.tag, v.previous])).toEqual([
      ['v2.0.0', 'v1.1.0'],
      ['v1.1.0', 'v1.0.0'],
    ])
    expect(await versionDetail({ ...options, tag: 'v1.0.0' })).toBeUndefined()
    expect((await versionDetail({ ...options, tag: 'v1.1.0' }))?.previous).toBe('v1.0.0')
  })

  test('keeps ranges between two version tags for good', async () => {
    const fake = history()
    const cache = memoryCache()
    const versions = await tagsOf(fake)
    const options = { forge: fake.forge, repo, settings, versions, cache }
    await versionTimeline(options)
    const reads = fake.listedCommits
    expect(cache.values.size).toBe(3)
    await versionTimeline(options)
    expect(fake.listedCommits).toBe(reads)

    const [newest, older] = versions
    expect(cache.values.has(rangeKey(repo, older!.sha, newest!.sha))).toBe(true)
  })

  test('does not cache ranges that end on a branch', async () => {
    const fake = history()
    const cache = memoryCache()
    const range = await collectRangeFacts({ forge: fake.forge, repo, to: 'main', cache })
    expect(range.commits.length).toBeGreaterThan(0)
    expect(cache.values.size).toBe(0)
  })

  test('details one version with entries, changelog, tasks and the compare link', async () => {
    const fake = history()
    const detail = await versionDetail({
      forge: fake.forge,
      repo,
      settings,
      versions: await tagsOf(fake),
      tag: 'v1.1.0',
      links,
    })
    expect(detail?.compareUrl).toBe('https://forge/g/app/-/compare/v1.0.0...v1.1.0')
    expect(detail?.changelog).toContain('### Features')
    expect(detail?.tasks).toEqual([
      {
        key: 'ABC-3',
        titles: ["Merge branch 'feature/ABC-3-shapes' into 'main'"],
        commits: 1,
        url: 'https://tracker.example.com/browse/ABC-3',
      },
      {
        key: 'ABC-2',
        titles: ['keep the order'],
        commits: 1,
        url: 'https://tracker.example.com/browse/ABC-2',
      },
    ])
    expect(
      await versionDetail({
        forge: fake.forge,
        repo,
        settings,
        versions: [],
        tag: 'v9.9.9',
      }),
    ).toBeUndefined()
  })

  test('details a release candidate against the version before it', async () => {
    const fake = history()
    const detail = await versionDetail({
      forge: fake.forge,
      repo,
      settings,
      versions: await tagsOf(fake),
      tag: 'v1.0.1-rc.1',
    })
    expect(detail).toMatchObject({ previous: 'v1.0.0', commitCount: 2, bump: 'patch' })
  })
})

const commit = (sha: string, subject: string, body = '') => ({
  sha,
  parents: [],
  author: { name: 'Dev', email: 'dev@example.com' },
  date: '2026-10-01T00:00:00Z',
  subject,
  body,
})

describe('tasks', () => {
  test('group commits by tracker key, titles deduplicated', () => {
    expect(
      releaseTasks([
        commit('c', 'fix: ABC-7 empty state'),
        commit('b', 'feat: [ABC-7] empty state'),
        commit('a', 'feat: plain change', 'Refs XYZ-12'),
        commit('d', 'docs: UTF-8 everywhere'),
      ]),
    ).toEqual([
      { key: 'ABC-7', titles: ['empty state'], commits: 2 },
      { key: 'XYZ-12', titles: ['plain change'], commits: 1 },
    ])
  })
})
