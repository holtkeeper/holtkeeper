import { beforeEach, describe, expect, test } from 'bun:test'

import type { Agent } from '@holtkeeper/agent'
import type { ApiPackage } from '@holtkeeper/api-surface'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { releaseAnnounceDefinition, releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { SettingEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import type { UsagesData } from '@holtkeeper/usages'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createUsageIndex } from '../src/api-surface/usages.ts'
import type { ServerDeps } from '../src/context.ts'
import { createEventDispatcher } from '../src/events.ts'
import {
  ANNOUNCE_INDEX_TIMEOUT_MS,
  type ReleaseAnnouncer,
  createReleaseAnnouncer,
  releaseAnnouncerFor,
} from '../src/release-announce.ts'
import type { SlackMessageBody, SlackPoster } from '../src/slack/client.ts'

const CHANNEL = 'C0123WIDGET'
const START = Date.parse('2026-11-12T09:00:00.000Z')
const app = { forge: 'work', path: 'g/app' }
const shop = { forge: 'work', path: 'g/shop' }

interface Sent extends SlackMessageBody {
  channel: string
  ts: string
  kind: 'post' | 'update'
}

let fake: FakeForge
let store: Store
let deps: ServerDeps
let clock: number
let sent: Sent[]
let agentCalls: { system?: string }[]
let announcer: ReleaseAnnouncer
let refusePost: string | undefined
let refuseUpdate: string | undefined

const vault = aesVault('v'.repeat(32))

const poster: SlackPoster = {
  post: async ({ channel, ...message }) => {
    if (refusePost) return { ok: false, error: refusePost }
    const ts = `1700000000.00${sent.length + 100}`
    sent.push({ kind: 'post', channel, ts, ...message })
    return { ok: true, channel, ts }
  },
  update: async ({ channel, ts, ...message }) => {
    if (refuseUpdate) return { ok: false, error: refuseUpdate }
    sent.push({ kind: 'update', channel, ts, ...message })
    return { ok: true, channel, ts }
  },
}

const setting = (key: string, value: unknown, scope: SettingEntry['scope'] = { all: true }) =>
  store.settings.put({
    id: `${key}-${JSON.stringify(scope)}`,
    key,
    scope,
    value,
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })

const announce = (value: Record<string, unknown> = {}) =>
  setting('releases.announce', { channels: [CHANNEL], ...value }, { groups: ['libs'] })

const fakeAgent = (
  fail = false,
  breaking: { change: string; migration?: string }[] = [],
): Agent => ({
  name: 'fake',
  run: async (task) => {
    agentCalls.push({ system: task.system })
    if (fail) {
      const error = new Error('weekly AI budget reached')
      error.name = 'BudgetExceededError'
      throw error
    }
    return {
      text: '',
      turns: 1,
      output: {
        packages: [
          {
            name: '@acme/widgets',
            overview: 'Widgets get a new shape.',
            highlights: ['Round widgets'],
            breaking,
          },
        ],
      },
    } as never
  },
})

const pkg = (name: string, version: string, exports: Record<string, string>): ApiPackage => ({
  name,
  version,
  private: false,
  dir: '.',
  entries: [
    {
      subpath: '.',
      symbols: Object.entries(exports).map(([symbol, signature]) => ({
        name: symbol,
        kind: signature.startsWith('interface') ? ('interface' as const) : ('function' as const),
        signature,
        file: 'src/index.ts',
        line: 1,
      })),
    },
  ],
})

const goPkg = (name: string, dir: string, version: string, exports: Record<string, string>) => ({
  ...pkg(name, version, exports),
  dir,
  ecosystem: 'Go' as const,
  module: 'gitlab.example/shapes/paint',
})

const indexRecord = async (ref: string, packages: ApiPackage[]) =>
  store.analyses.add({
    repo: app,
    kind: 'api-surface',
    ref,
    createdAt: new Date(clock).toISOString(),
    data: { packages },
  })

const shopUsage: UsagesData = {
  packages: [
    {
      name: '@acme/widgets',
      versions: ['1.0.0'],
      ranges: ['^1.0.0'],
      workspaces: ['root'],
      count: 2,
      files: 1,
      exports: [
        {
          name: 'Widget',
          subpath: '.',
          count: 2,
          files: 1,
          kinds: { jsx: 2 },
          members: [],
          props: [{ name: 'size', count: 2 }],
          spread: 0,
          sites: [
            {
              file: 'src/Cart.tsx',
              line: 12,
              column: 3,
              kind: 'jsx',
              props: ['size'],
              snippet: '<Widget size={1} />',
              snippetLine: 12,
            },
          ],
        },
      ],
    },
  ],
  files: 10,
  types: { status: 'skipped' },
}

const finishJobs = async (outcome: 'complete' | 'fail' = 'complete') => {
  const at = new Date(clock).toISOString()
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one job at a time, as a worker claims them
    const job = await store.jobs.claim('worker-1', at)
    if (!job) return
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (outcome === 'complete') await store.jobs.complete(job.id, { at })
    // oxlint-disable-next-line no-await-in-loop -- see above
    else await store.jobs.fail(job.id, { at, error: 'checkout failed' })
  }
}

const queuedRefs = async () =>
  (await store.jobs.list({ analyzer: 'api-surface', limit: 50 }))
    .map((job) => job.ref ?? '')
    .toSorted((a, b) => a.localeCompare(b))

const tick = (minutes: number) => {
  clock += minutes * 60_000
}

const posts = () => sent.filter((entry) => entry.kind === 'post')
const shown = (entry: Sent | undefined) => JSON.stringify(entry?.blocks ?? [])

const tagNow = async (name: string) => {
  fake.tag(name)
  const tag = fake.tags.find((candidate) => candidate.name === name)!
  await announcer.onTag(app, { name, sha: tag.sha })
}

const widgetsV1 = () =>
  pkg('@acme/widgets', '1.0.0', {
    Widget: 'function Widget(props: WidgetProps): Element',
    Gizmo: 'function Gizmo(): void',
  })

const breakingRelease = async (version: string) => {
  fake.commitTo('main', 'feat!: [ABC-9] widgets drop the old API')
  await tagNow(`@acme/widgets@${version}`)
}

const fixRelease = async (version: string) => {
  fake.commitTo('main', `fix: [ABC-13] widget ${version}`)
  await tagNow(`@acme/widgets@${version}`)
  tick(10)
  await announcer.advance(app)
}

const makeDeps = (): ServerDeps => {
  const config = parseConfig({
    forges: { work: { kind: 'gitlab', url: 'https://git.acme.test', create: () => fake.forge } },
    groups: {
      libs: { forge: 'work', include: ['g/app'] },
      shops: { forge: 'work', include: ['g/shop'] },
    },
  })
  return {
    config,
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, releaseSettingsDefinition, releaseAnnounceDefinition],
    analyses: [],
    analyzers: [{ kind: 'api-surface', scope: 'repo', options: z.object({}).passthrough() }],
    slackPoster: () => poster,
    automaticAgentFor: async () => fakeAgent(),
    now: () => new Date(clock),
  }
}

beforeEach(async () => {
  clock = START
  sent = []
  refusePost = undefined
  refuseUpdate = undefined
  agentCalls = []
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first widget')
  fake.tag('@acme/widgets@1.0.0')
  fake.tag('v0.9.0')
  store = memoryStore()
  deps = makeDeps()
  await store.kv?.set('chat:slack:connection', {
    botToken: await vault.seal('xoxb-widget'),
    signingSecret: await vault.seal('shape-secret'),
    connectedAt: new Date(START).toISOString(),
    connectedBy: 'header:jane',
  })
  await store.analyses.add({
    repo: shop,
    kind: 'usages',
    ref: 'main',
    createdAt: new Date(START).toISOString(),
    data: shopUsage,
  })
  announcer = createReleaseAnnouncer(deps, {
    timers: false,
    log: () => {},
    usages: createUsageIndex({ analyses: store.analyses, refreshMs: 0 }),
  })
})

describe('detection', () => {
  test('the first look records a baseline and announces no history', async () => {
    await announce({ impact: false, notes: false })
    await announcer.sweep()
    tick(60)
    await announcer.sweep()
    expect(sent).toEqual([])
    expect((await announcer.stateOf(app))?.seen.toSorted((a, b) => a.localeCompare(b))).toEqual([
      '@acme/widgets@1.0.0',
      'v0.9.0',
    ])

    fake.commitTo('main', 'fix: [ABC-2] widget crash')
    fake.tag('v0.9.1')
    tick(16)
    await announcer.sweep()
    expect(sent).toEqual([])
    tick(11)
    await announcer.sweep()
    expect(posts()).toHaveLength(1)
    expect(posts()[0]?.text).toBe('g/app 0.9.1 released')
    expect(shown(posts()[0])).toContain('widget crash')
    expect(shown(posts()[0])).toContain('ABC-2')
    tick(60)
    await announcer.sweep()
    expect(posts()).toHaveLength(1)
  })

  test('without channels nothing is recorded, and turning them off forgets the baseline', async () => {
    await announcer.sweep()
    expect(await announcer.stateOf(app)).toBeUndefined()
    await announce({ impact: false })
    await announcer.sweep()
    expect(await announcer.stateOf(app)).toBeDefined()
    await setting('releases.announce', { channels: [] }, { groups: ['libs'] })
    await announcer.sweep()
    expect(await announcer.stateOf(app)).toBeUndefined()
  })

  test('a pushed tag before any baseline is still new; tag globs filter', async () => {
    await announce({ impact: false, notes: false, tags: ['@acme/widgets@*'] })
    fake.commitTo('main', 'feat: [ABC-3] round widgets')
    await tagNow('@acme/widgets@1.1.0')
    await tagNow('@acme/gadgets@2.0.0')
    tick(10)
    await announcer.advance(app)
    expect(posts()).toHaveLength(1)
    expect(posts()[0]?.text).toBe('@acme/widgets 1.1.0 released')
    expect(shown(posts()[0])).toContain('since 1.0.0')
    expect(shown(posts()[0])).not.toContain('gadgets')
  })

  test('tags within the window make one message per monorepo release', async () => {
    await announce({ impact: false, notes: false })
    await announcer.sweep()
    fake.commitTo(
      'main',
      'feat(widgets): [ABC-4] round widgets',
      'fix(gadgets): [ABC-5] gadget size',
    )
    await tagNow('@acme/widgets@1.1.0')
    tick(3)
    await tagNow('@acme/gadgets@2.0.0')
    tick(5)
    await announcer.advance(app)
    expect(sent).toEqual([])
    tick(3)
    await announcer.advance(app)
    expect(posts()).toHaveLength(1)
    expect(posts()[0]?.text).toBe('New versions in g/app: @acme/widgets 1.1.0, @acme/gadgets 2.0.0')
    expect(shown(posts()[0])).toContain('*@acme/gadgets 2.0.0*')

    tick(20)
    fake.commitTo('main', 'fix: [ABC-6] widget edge')
    await tagNow('@acme/widgets@1.1.1')
    tick(10)
    await announcer.advance(app)
    expect(posts()).toHaveLength(2)
    expect(posts()[1]?.text).toBe('@acme/widgets 1.1.1 released')
  })

  test('two processes announce a batch once', async () => {
    await announce({ impact: false, notes: false })
    const other = createReleaseAnnouncer(makeDeps(), { timers: false, log: () => {} })
    fake.commitTo('main', 'feat: [ABC-7] widget colors')
    fake.tag('@acme/widgets@1.2.0')
    const tag = fake.tags[0]!
    await Promise.all([
      announcer.onTag(app, { name: tag.name, sha: tag.sha }),
      other.onTag(app, { name: tag.name, sha: tag.sha }),
    ])
    expect((await announcer.stateOf(app))?.batches).toHaveLength(1)
    tick(10)
    await Promise.all([
      announcer.advance(app),
      other.advance(app),
      announcer.sweep(),
      other.sweep(),
    ])
    expect(posts()).toHaveLength(1)
  })

  test('forge tag events reach the announcer through the dispatcher', async () => {
    await announce({ impact: false, notes: false })
    const background: Promise<unknown>[] = []
    const dispatched = {
      ...makeDeps(),
      onBackground: (work: Promise<unknown>) => void background.push(work),
    }
    releaseAnnouncerFor(dispatched, { timers: false, log: () => {} })
    fake.commitTo('main', 'feat: [ABC-8] widget shadows')
    fake.tag('@acme/widgets@1.3.0')
    await createEventDispatcher(dispatched)(
      { kind: 'tag', repo: app, tag: '@acme/widgets@1.3.0', sha: fake.tags[0]!.sha },
      { actor: 'webhook:gitlab', via: 'webhook' },
    )
    await Promise.all(background)
    expect((await announcer.stateOf(app))?.batches[0]?.tags.map((tag) => tag.name)).toEqual([
      '@acme/widgets@1.3.0',
    ])
  })
  test('tag events reach the announcer when the server keeps no background list', async () => {
    await announce({ impact: false, notes: false })
    const dispatched = makeDeps()
    const own = releaseAnnouncerFor(dispatched, { timers: false, log: () => {} })
    fake.commitTo('main', 'feat: [ABC-14] widget borders')
    fake.tag('@acme/widgets@1.4.0')
    await createEventDispatcher(dispatched)(
      { kind: 'tag', repo: app, tag: '@acme/widgets@1.4.0', sha: fake.tags[0]!.sha },
      { actor: 'webhook:gitlab', via: 'webhook' },
    )
    await own.advance(app)
    expect((await own.stateOf(app))?.batches[0]?.tags.map((tag) => tag.name)).toEqual([
      '@acme/widgets@1.4.0',
    ])
  })

  test('a broader tag filter later does not announce tags that existed before', async () => {
    await announce({ impact: false, notes: false, tags: ['@acme/widgets@*'] })
    await announcer.sweep()
    fake.tag('@acme/gadgets@3.0.0')
    tick(16)
    await announcer.sweep()
    await announce({ impact: false, notes: false })
    tick(16)
    await announcer.sweep()
    tick(11)
    await announcer.sweep()
    expect(sent).toEqual([])
  })

  test('each package of a monorepo batch lists its own commits', async () => {
    await announce({ impact: false, notes: false })
    await announcer.sweep()
    fake.commitTo(
      'main',
      'feat(widgets): [ABC-15] round widgets',
      'fix(gadgets): [ABC-16] gadget size',
    )
    await tagNow('@acme/widgets@1.1.0')
    await tagNow('@acme/gadgets@2.0.0')
    tick(10)
    await announcer.advance(app)
    const message = shown(posts()[0])
    const widgets = message.slice(0, message.indexOf('*@acme/gadgets 2.0.0*'))
    expect(widgets).toContain('round widgets')
    expect(widgets).not.toContain('gadget size')
  })
})

describe('impact', () => {
  test('the announcement waits for the API index of both versions', async () => {
    await announce({ notes: false })
    await breakingRelease('2.0.0')
    expect(await queuedRefs()).toEqual(
      [fake.tags.at(-1)!.sha, fake.tags[0]!.sha].toSorted((a, b) => a.localeCompare(b)),
    )
    tick(10)
    await announcer.advance(app)
    expect(sent).toEqual([])

    await indexRecord(fake.tags.at(-1)!.sha, [widgetsV1()])
    await indexRecord(fake.tags[0]!.sha, [
      pkg('@acme/widgets', '2.0.0', { Gizmo: 'function Gizmo(): void' }),
    ])
    await finishJobs()
    await announcer.indexFinished((await store.jobs.list({ analyzer: 'api-surface' }))[0]!)
    expect(posts()).toHaveLength(1)
    const message = shown(posts()[0])
    expect(message).toContain('*Will break on upgrade*')
    expect(message).toContain(
      '<https://git.acme.test/g/shop|g/shop> (on 1.0.0): 2 broken uses of `Widget`',
    )
    expect(message).toContain('https://git.acme.test/g/shop/-/blob/main/src/Cart.tsx#L12')
    expect(message).toContain('`Widget` was removed')
    expect(message).not.toContain('Compatibility analysis')
  })

  test('a Go module tag announces the changes of every package the tag versioned', async () => {
    await announce({ notes: false })
    const sha = (name: string) => fake.tags.find((tag) => tag.name === name)!.sha
    await indexRecord(sha('v0.9.0'), [
      goPkg('gitlab.example/shapes/paint', '.', 'v0.9.0', { Mix: 'func Mix()' }),
      goPkg('gitlab.example/shapes/paint/brush', 'brush', 'v0.9.0', {
        Stroke: 'func Stroke()',
        Dab: 'func Dab()',
      }),
    ])
    fake.commitTo('main', 'feat!: [ABC-21] brushes drop dabs')
    await tagNow('v1.2.0')
    await indexRecord(sha('v1.2.0'), [
      goPkg('gitlab.example/shapes/paint', '.', 'v1.2.0', { Mix: 'func Mix()' }),
      goPkg('gitlab.example/shapes/paint/brush', 'brush', 'v1.2.0', { Stroke: 'func Stroke()' }),
    ])
    tick(10)
    await announcer.advance(app)
    const message = posts()
      .map((entry) => shown(entry))
      .find((text) => text.includes('1.2.0'))
    expect(message).toContain('`Dab` was removed')
  })

  test('no connected repository affected, and no block when nothing breaks', async () => {
    await announce({ notes: false })
    await indexRecord(fake.tags.at(-1)!.sha, [widgetsV1()])
    await breakingRelease('2.0.0')
    await indexRecord(fake.tags[0]!.sha, [
      pkg('@acme/widgets', '2.0.0', { Widget: 'function Widget(props: WidgetProps): Element' }),
    ])
    expect(await queuedRefs()).toEqual([fake.tags[0]!.sha])
    tick(10)
    await announcer.advance(app)
    expect(shown(posts()[0])).toContain('No connected repository is affected.')

    tick(30)
    fake.commitTo('main', 'feat: [ABC-10] widget hints')
    await tagNow('@acme/widgets@2.1.0')
    await indexRecord(fake.tags[0]!.sha, [
      pkg('@acme/widgets', '2.1.0', {
        Widget: 'function Widget(props: WidgetProps): Element',
        Hint: 'function Hint(): void',
      }),
    ])
    tick(10)
    await announcer.advance(app)
    expect(posts()).toHaveLength(2)
    expect(shown(posts()[1])).not.toContain('Will break on upgrade')
  })

  test('after 30 minutes it posts without impact and updates the message once indexed', async () => {
    await announce({ notes: false })
    await indexRecord(fake.tags.at(-1)!.sha, [widgetsV1()])
    await breakingRelease('2.0.0')
    tick(10)
    await announcer.advance(app)
    expect(sent).toEqual([])
    tick(ANNOUNCE_INDEX_TIMEOUT_MS / 60_000 - 10)
    await announcer.advance(app)
    expect(posts()).toHaveLength(1)
    expect(shown(posts()[0])).toContain('Compatibility analysis is still running')
    expect(shown(posts()[0])).not.toContain('Will break on upgrade')

    await indexRecord(fake.tags[0]!.sha, [
      pkg('@acme/widgets', '2.0.0', { Gizmo: 'function Gizmo(): void' }),
    ])
    await announcer.advance(app)
    await announcer.advance(app)
    const updates = sent.filter((entry) => entry.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ channel: CHANNEL, ts: posts()[0]!.ts })
    expect(shown(updates[0])).toContain('Will break on upgrade')
    expect(shown(updates[0])).not.toContain('Compatibility analysis')
    expect(posts()).toHaveLength(1)
  })

  test('failed indexing posts at once with the pending line', async () => {
    await announce({ notes: false })
    await indexRecord(fake.tags.at(-1)!.sha, [widgetsV1()])
    await breakingRelease('2.0.0')
    await finishJobs('fail')
    tick(10)
    await announcer.advance(app)
    expect(shown(posts()[0])).toContain('Compatibility analysis is still running')
    tick(25 * 60)
    await announcer.advance(app)
    expect(shown(sent.at(-1))).toContain('Compatibility analysis is unavailable')
  })
})

describe('notes', () => {
  test('notes come from one fast call; a blocked budget leaves them out', async () => {
    await announce({ impact: false })
    fake.commitTo('main', 'feat: [ABC-11] round widgets')
    await tagNow('@acme/widgets@1.1.0')
    tick(10)
    await announcer.advance(app)
    expect(agentCalls).toHaveLength(1)
    expect(shown(posts()[0])).toContain('Widgets get a new shape.')

    const blocked = createReleaseAnnouncer(
      { ...deps, automaticAgentFor: async () => fakeAgent(true) },
      { timers: false, log: () => {} },
    )
    fake.commitTo('main', 'fix: [ABC-12] widget edge')
    fake.tag('@acme/widgets@1.1.1')
    await blocked.onTag(app, { name: '@acme/widgets@1.1.1', sha: fake.tags[0]!.sha })
    tick(10)
    await blocked.advance(app)
    expect(agentCalls).toHaveLength(2)
    expect(posts()).toHaveLength(2)
    expect(shown(posts()[1])).not.toContain('Widgets get a new shape.')
    expect(shown(posts()[1])).toContain('widget edge')
  })

  test('the language comes from the setting, else the review language, else English', async () => {
    await announce({ impact: false })
    await fixRelease('1.0.1')
    await setting('analyzers.review', { language: 'French' })
    await fixRelease('1.0.2')
    await announce({ impact: false, language: 'German' })
    await fixRelease('1.0.3')
    expect(
      agentCalls.map((call) => /Write the prose in (\w+)/.exec(call.system ?? '')?.[1]),
    ).toEqual(['English', 'French', 'German'])
  })
})

describe('slack failures', () => {
  test('a refused post is tried again later, a final error gives up', async () => {
    await announce({ impact: false, notes: false })
    fake.commitTo('main', 'feat: [ABC-17] widget rims')
    refusePost = 'not_in_channel'
    await tagNow('@acme/widgets@1.5.0')
    tick(10)
    await announcer.advance(app)
    expect(sent).toEqual([])
    expect((await announcer.stateOf(app))?.batches[0]).toMatchObject({
      status: 'collecting',
      attempts: 1,
    })
    refusePost = undefined
    await announcer.advance(app)
    expect(sent).toEqual([])
    tick(1)
    await announcer.advance(app)
    expect(posts()).toHaveLength(1)

    fake.commitTo('main', 'fix: [ABC-18] widget rims again')
    refusePost = 'channel_not_found'
    await tagNow('@acme/widgets@1.5.1')
    tick(10)
    await announcer.advance(app)
    expect((await announcer.stateOf(app))?.batches.at(-1)).toMatchObject({
      status: 'posted',
      posts: [],
    })
  })

  test('without a Slack credential the batch waits for one', async () => {
    await announce({ impact: false, notes: false })
    await store.kv?.delete('chat:slack:connection')
    fake.commitTo('main', 'feat: [ABC-19] widget glow')
    await tagNow('@acme/widgets@1.6.0')
    tick(10)
    await announcer.advance(app)
    expect((await announcer.stateOf(app))?.batches[0]?.status).toBe('collecting')
    await store.kv?.set('chat:slack:connection', {
      botToken: await vault.seal('xoxb-widget'),
      signingSecret: await vault.seal('shape-secret'),
      connectedAt: new Date(clock).toISOString(),
      connectedBy: 'header:jane',
    })
    tick(2)
    await announcer.advance(app)
    expect(posts()).toHaveLength(1)
  })

  test('a batch left mid-post by a dead process is given up, not posted twice', async () => {
    await announce({ impact: false, notes: false })
    fake.commitTo('main', 'feat: [ABC-20] widget tilt')
    await tagNow('@acme/widgets@1.7.0')
    const state = (await announcer.stateOf(app))!
    state.batches[0]!.status = 'posting'
    state.batches[0]!.claimedAt = new Date(clock).toISOString()
    await store.kv?.set('release:announce:work:g/app', state)
    tick(10)
    await announcer.advance(app)
    expect((await announcer.stateOf(app))?.batches[0]?.status).toBe('posting')
    tick(10)
    await announcer.advance(app)
    expect((await announcer.stateOf(app))?.batches[0]?.status).toBe('posted')
    tick(10)
    await announcer.advance(app)
    expect(sent).toEqual([])
  })

  test('a refused update keeps the impact pending and is tried again', async () => {
    await announce({ notes: false })
    await indexRecord(fake.tags.at(-1)!.sha, [widgetsV1()])
    await breakingRelease('2.0.0')
    tick(ANNOUNCE_INDEX_TIMEOUT_MS / 60_000)
    await announcer.advance(app)
    expect(posts()).toHaveLength(1)
    await indexRecord(fake.tags[0]!.sha, [
      pkg('@acme/widgets', '2.0.0', { Gizmo: 'function Gizmo(): void' }),
    ])
    refuseUpdate = 'ratelimited'
    await announcer.advance(app)
    expect((await announcer.stateOf(app))?.batches[0]?.impact).toBe('pending')
    refuseUpdate = undefined
    await announcer.advance(app)
    expect(sent.filter((entry) => entry.kind === 'update')).toHaveLength(1)
    expect((await announcer.stateOf(app))?.batches[0]?.impact).toBe('included')
  })
})

const breakingIndexed = async () => {
  await indexRecord(fake.tags.at(-1)!.sha, [widgetsV1()])
  await breakingRelease('2.0.0')
  await indexRecord(fake.tags[0]!.sha, [
    pkg('@acme/widgets', '2.0.0', { Gizmo: 'function Gizmo(): void' }),
  ])
  tick(10)
  await announcer.advance(app)
  return shown(posts()[0])
}

describe('impact reach and notes', () => {
  test('access.crossTeam off counts other teams instead of naming them', async () => {
    await announce({ notes: false })
    await setting('access.crossTeam', 'off')
    const message = await breakingIndexed()
    expect(message).toContain('1 repository of other teams')
    expect(message).not.toContain('g/shop')
  })

  test('access.crossTeam metadata names other teams without file links', async () => {
    await announce({ notes: false })
    await setting('access.crossTeam', 'metadata')
    const message = await breakingIndexed()
    expect(message).toContain('g/shop|g/shop')
    expect(message).not.toContain('Cart.tsx')
  })

  test('API breaking changes are added to the ones the notes name', async () => {
    deps.automaticAgentFor = async () =>
      fakeAgent(false, [{ change: 'Widgets drop the old API', migration: 'Use Gizmo.' }])
    await announce()
    const message = await breakingIndexed()
    expect(message).toContain('Widgets drop the old API')
    expect(message).toContain('`Widget` was removed')
  })

  test('without usage data the impact says so', async () => {
    await announce({ notes: false })
    await store.analyses.prune({ repo: shop, kind: 'usages', keep: 0 })
    const message = await breakingIndexed()
    expect(message).toContain('No usage data from connected repositories yet.')
  })
})
