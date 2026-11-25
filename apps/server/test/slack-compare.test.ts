import { beforeEach, describe, expect, test } from 'bun:test'

import type { RepoTarget } from '@holtkeeper/access'
import type { Agent, AgentResult, AgentTask } from '@holtkeeper/agent'
import { BudgetDeniedError } from '@holtkeeper/ai-usage'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { Deployment, GitForge } from '@holtkeeper/forge'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import type { ChatAgentRun } from '../src/chat-threads.ts'
import type { ServerDeps } from '../src/context.ts'
import type { SlackPoster } from '../src/slack/client.ts'
import { compareThreads } from '../src/slack/compare-state.ts'
import { slackSignature } from '../src/slack/signature.ts'

const NOW = new Date('2026-11-03T09:00:00.000Z')
const SECRET = 'shape-secret'
const CHANNEL = 'C0123SHAPES'
const ROOT = '1700000000.000100'
const WIDGET = 'shapes/widget-service'
const GADGET = 'shapes/gadget-check'

const vault = aesVault('v'.repeat(32))

/** One fake repository per path, behind one forge. */
let fakes: Record<string, FakeForge>
let deployments: Record<string, Deployment[]>

const fakeFor = () => {
  const fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first widget')
  fake.tag('v1.0.0')
  fake.commitTo('main', 'feat: [ABC-2] round widgets', 'fix!: [ABC-3] drop square widgets')
  fake.tag('v1.1.0')
  fake.commitTo('main', 'feat: [ABC-4] shiny widgets')
  fake.tag('v1.2.0')
  fake.addPipeline('v1.2.0', 'success', [
    { name: 'deploy-cert', status: 'success' },
    { name: 'deploy-prod', status: 'manual' },
  ])
  return fake
}

const routed = new Proxy({} as GitForge, {
  get(_, name: string) {
    if (name === 'kind') return 'gitlab'
    if (name === 'listDeployments')
      return async (path: string, query: { environment?: string }) =>
        (deployments[path] ?? []).filter((entry) => entry.environment === query.environment)
    const sample = (fakes[WIDGET]!.forge as unknown as Record<string, unknown>)[name]
    if (typeof sample !== 'function') return sample
    return (path: string, ...rest: unknown[]) => {
      const fake = fakes[path]
      if (!fake) throw new Error(`no repository ${path}`)
      const method = (fake.forge as unknown as Record<string, (...args: unknown[]) => unknown>)[
        name
      ]
      return method!(path, ...rest)
    }
  },
})

const prodAt = (path: string, tag: string): Deployment => ({
  id: 1,
  environment: 'production',
  status: 'success',
  sha: fakes[path]!.tags.find((entry) => entry.name === tag)!.sha,
  ref: tag,
  createdAt: '2026-10-20T10:00:00.000Z',
})

interface AgentCall {
  target: RepoTarget
  run: ChatAgentRun
  task: AgentTask
}

let store: Store
let deps: ServerDeps
let app: ReturnType<typeof createApp>
let background: Promise<unknown>[]
let posts: { channel: string; threadTs?: string; text: string; blocks: string }[]
let calls: AgentCall[]
let parseAnswers: unknown[]
let failParse: Error | undefined
let withAgent: boolean
let identityCalls = 0

const fakePoster: SlackPoster = {
  post: async ({ channel, threadTs, text, blocks }) => {
    const ts = `1700000100.${String(posts.length + 1).padStart(6, '0')}`
    posts.push({
      channel,
      ...(threadTs !== undefined && { threadTs }),
      text,
      blocks: JSON.stringify(blocks ?? []),
    })
    return { ok: true, channel, ts }
  },
  update: async ({ channel, ts }) => ({ ok: true, channel, ts }),
  botUserId: async () => {
    identityCalls++
    return 'U0BOT'
  },
}

const respond = (task: AgentTask): AgentResult => {
  if (task.taskKind === 'release-compare-parse') {
    if (failParse) throw failParse
    return { text: '', output: parseAnswers.shift(), turns: 1, costUsd: 0.001 }
  }
  if (task.taskKind === 'release-compare-summary')
    return { text: '- Widgets got rounder; square widgets are gone.', turns: 1 }
  return { text: 'ABC-4 adds **shiny widgets**.', turns: 2 }
}

const buildApp = () => {
  app = createApp(deps)
}

const settle = async () => {
  while (background.length > 0) await Promise.all(background.splice(0))
}

beforeEach(async () => {
  fakes = { [WIDGET]: fakeFor(), [GADGET]: fakeFor() }
  deployments = {}
  deployments[WIDGET] = [prodAt(WIDGET, 'v1.0.0')]
  deployments[GADGET] = [prodAt(GADGET, 'v1.1.0')]
  store = memoryStore()
  background = []
  posts = []
  calls = []
  parseAnswers = []
  failParse = undefined
  withAgent = true
  identityCalls = 0
  deps = {
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://git.acme.test', create: () => routed } },
      teams: { shapes: { owns: [`work:${WIDGET}`, `work:${GADGET}`] } },
      server: {
        auth: noAuth(),
        store,
        vaultKey: 'v'.repeat(32),
        publicUrl: 'https://holtkeeper.acme.test',
      },
    }),
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    now: () => NOW,
    releasePollMs: 1,
    releaseRefreshDelayMs: 0,
    issueTracker: async () => undefined,
    slackPoster: () => fakePoster,
    chatAgentFor: async (target, run) => {
      if (!withAgent) return undefined
      const agent: Agent = {
        name: 'fake',
        run: async <Output>(task: AgentTask<Output>) => {
          calls.push({ target, run, task })
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake answers what each task kind expects
          return respond(task) as AgentResult<Output>
        },
      }
      return agent
    },
    onBackground: (work) => void background.push(work),
  }
  await store.settings.put({
    id: 'releases',
    key: 'releases',
    scope: { all: true },
    value: {
      enabled: true,
      acceptance: 'manual',
      flow: { mode: 'trunk' },
      deploy: {
        environments: [
          { name: 'certification', job: 'deploy-cert' },
          { name: 'production', job: 'deploy-prod' },
        ],
      },
    },
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  await store.kv?.set('chat:slack:connection', {
    botToken: await vault.seal('xoxb-shapes'),
    signingSecret: await vault.seal(SECRET),
    connectedAt: NOW.toISOString(),
    connectedBy: 'header:jane',
  })
  buildApp()
})

const signed = (path: string, body: string, contentType: string, headers = {}) => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  return app.request(`/api${path}`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': slackSignature(SECRET, timestamp, body),
      ...headers,
    },
    body,
  })
}

let eventCount = 0

const deliver = async (
  event: Record<string, unknown>,
  options: {
    eventId?: string
    headers?: Record<string, string>
    authorizations?: Record<string, unknown>[] | null
  } = {},
) => {
  eventCount++
  const authorizations =
    options.authorizations === undefined
      ? [{ user_id: 'U0BOT', is_bot: true }]
      : options.authorizations
  const response = await signed(
    '/slack/events',
    JSON.stringify({
      type: 'event_callback',
      event_id: options.eventId ?? `Ev${eventCount}`,
      event,
      ...(authorizations && { authorizations }),
    }),
    'application/json',
    options.headers,
  )
  expect(response.status).toBe(200)
  await settle()
}

const mentionEvent = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'message',
  channel: CHANNEL,
  channel_type: 'channel',
  user: 'U0123ALEX',
  text: `<@U0BOT> ${text}`,
  ts: ROOT,
  ...extra,
})

const mention = (text: string, extra: Record<string, unknown> = {}) =>
  deliver(mentionEvent(text, extra))

let replyCount = 0

const plainReply = (text: string, extra: Record<string, unknown> = {}) => {
  replyCount++
  return deliver({
    type: 'message',
    channel: CHANNEL,
    channel_type: 'channel',
    user: 'U0123ALEX',
    text,
    ts: `1700000200.${String(replyCount).padStart(6, '0')}`,
    thread_ts: ROOT,
    ...extra,
  })
}

const threadReply = (text: string, extra: Record<string, unknown> = {}) =>
  plainReply(`<@U0BOT> ${text}`, extra)

const click = async (value: string) => {
  const payload = {
    type: 'block_actions',
    user: { id: 'U0456SAM' },
    channel: { id: CHANNEL },
    message: { ts: '1700000100.000001', thread_ts: ROOT },
    actions: [{ action_id: 'holtkeeper:command:0', value }],
  }
  const response = await signed(
    '/slack/interactions',
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    'application/x-www-form-urlencoded',
  )
  expect(response.status).toBe(200)
  await settle()
}

const bothRepos = {
  repos: ['widget service', 'Gadget-Check'],
  unknown: [],
  from: 'cert',
  to: 'prod',
  focus: [],
  language: 'English',
  intent: 'request',
}

const threadState = () => compareThreads(store, () => NOW).get(CHANNEL, ROOT)

const parseCalls = () => calls.filter((call) => call.task.taskKind === 'release-compare-parse')

describe('slack environment comparison', () => {
  test('mention, correction, confirmation, summary with links and a follow-up question', async () => {
    parseAnswers.push(bothRepos)
    await mention('hi, could you compare the widget service and gadget check between cert and prod')

    expect(posts).toHaveLength(1)
    const preview = posts[0]!
    expect(preview.threadTs).toBe(ROOT)
    expect(preview.blocks).toContain(WIDGET)
    expect(preview.blocks).toContain(GADGET)
    expect(preview.blocks).toContain('certification `1.2.0` → production `1.0.0`')
    expect(preview.blocks).toContain('certification `1.2.0` → production `1.1.0`')
    expect(preview.blocks).toContain('"value":"compare confirm"')
    const parse = parseCalls()[0]!
    expect(parse.task.tier).toBe('fast')
    expect(parse.task.prompt).toContain(`work:${WIDGET} (environments: certification, production)`)
    expect(parse.task.prompt).not.toContain('<@U0BOT>')
    expect(parse.run.actor).toBe('slack:U0123ALEX')
    expect((await threadState())?.status).toBe('pending')

    parseAnswers.push({ ...bothRepos, repos: [`work:${WIDGET}`] })
    await threadReply('only the widget service please')
    expect(posts).toHaveLength(2)
    expect(posts[1]!.blocks).toContain(WIDGET)
    expect(posts[1]!.blocks).not.toContain(GADGET)
    expect(parseCalls()[1]!.task.prompt).toContain('Previous request:')

    buildApp()
    parseAnswers.push({ ...bothRepos, intent: 'confirm' })
    await threadReply('yes')
    expect(parseCalls()).toHaveLength(3)
    expect(posts[2]!.blocks).toContain('Check started for 1 repository')

    const summary = posts[3]!
    expect(summary.threadTs).toBe(ROOT)
    expect(summary.text).toBe('Compared cert with prod')
    expect(summary.blocks).toContain('Widgets got rounder')
    expect(summary.blocks).toContain('3 commits')
    expect(summary.blocks).toContain('1 breaking')
    expect(summary.blocks).toContain('ABC-4')
    expect(summary.blocks).toContain(
      'https://holtkeeper.acme.test/releases/compare?repo=work%3Ashapes%2Fwidget-service',
    )
    expect(summary.blocks).toContain('from=v1.0.0')
    expect(summary.blocks).toContain('to=v1.2.0')
    expect(summary.blocks).toContain('production is behind')
    const summaryCall = calls.find((call) => call.task.taskKind === 'release-compare-summary')!
    expect(summaryCall.task.tier).toBe('fast')
    const done = await threadState()
    expect(done?.status).toBe('done')
    expect(done?.results?.[0]?.comparison?.tasks.map((task) => task.key)).toEqual([
      'ABC-4',
      'ABC-3',
      'ABC-2',
    ])

    await threadReply('what does ABC-4 do?')
    const question = calls.find((call) => call.task.taskKind === 'chat')!
    expect(question.target).toMatchObject({ forge: 'work', path: WIDGET, teams: ['shapes'] })
    expect(question.run.requester.grants[0]?.actions).toContain('releases:read')
    expect(question.task.prompt).toContain('what does ABC-4 do?')
    expect(question.task.prompt).toContain('"key": "ABC-4"')
    expect(posts.at(-1)!.blocks).toContain('shiny widgets')
    expect((await threadState())?.turns).toHaveLength(2)
  })

  test("Slack's retries of a mention are handled once", async () => {
    parseAnswers.push(bothRepos, bothRepos)
    await mention('compare widget service between cert and prod')
    await deliver(mentionEvent('compare widget service between cert and prod'), {
      eventId: `Ev${eventCount}`,
      headers: { 'x-slack-retry-num': '1' },
    })
    expect(posts).toHaveLength(1)
    expect(parseCalls()).toHaveLength(1)
  })

  test('messages that mention someone else or nobody are not requests', async () => {
    await deliver({ ...mentionEvent('x'), text: '<@U0456SAM> compare cert and prod' })
    await deliver({ ...mentionEvent('x'), text: 'compare cert and prod', ts: '1700000500.000001' })
    expect(posts).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('without authorizations in the delivery the bot asks Slack who it is, once', async () => {
    parseAnswers.push(bothRepos, bothRepos)
    await deliver(mentionEvent('compare both between cert and prod'), { authorizations: null })
    await deliver(mentionEvent('compare both between cert and prod', { ts: '1700000600.000001' }), {
      authorizations: null,
    })
    expect(parseCalls()).toHaveLength(2)
    expect(identityCalls).toBe(1)
  })

  test('the button starts the run once; a second click does nothing', async () => {
    parseAnswers.push(bothRepos)
    await mention('compare both between cert and prod')
    await click('compare confirm')
    await click('compare confirm')
    const started = posts.filter((post) => post.blocks.includes('Check started'))
    expect(started).toHaveLength(1)
    expect(started[0]!.blocks).toContain('Check started for 2 repositories')
    const summary = posts.at(-1)!
    expect(summary.blocks).toContain(WIDGET)
    expect(summary.blocks).toContain(GADGET)
    expect((await threadState())?.status).toBe('done')
  })

  test('cancel, then a correction starts over', async () => {
    parseAnswers.push(bothRepos)
    await mention('compare both between cert and prod')
    await click('compare cancel')
    expect(posts.at(-1)!.blocks).toContain('Cancelled.')
    expect((await threadState())?.status).toBe('cancelled')
    parseAnswers.push({ ...bothRepos, repos: [`work:${GADGET}`] })
    await threadReply('actually just the gadget check')
    expect((await threadState())?.status).toBe('pending')
    expect(posts.at(-1)!.blocks).toContain(GADGET)
  })

  test('a confirmation in another language goes through the parser', async () => {
    parseAnswers.push(bothRepos, { ...bothRepos, intent: 'confirm' })
    await mention('compare both between cert and prod')
    await threadReply('jawohl, los')
    expect(parseCalls()).toHaveLength(2)
    expect((await threadState())?.status).toBe('done')
  })

  test('unknown repositories and environments are explained without buttons', async () => {
    parseAnswers.push({
      ...bothRepos,
      repos: ['work:shapes/kite-runner', 'widget service'],
      unknown: ['moon base'],
      to: 'staging',
    })
    await mention('compare kite runner, moon base and widget service between cert and staging')
    const preview = posts[0]!
    expect(preview.blocks).toContain('I could not find')
    expect(preview.blocks).toContain('moon base')
    expect(preview.blocks).toContain('kite-runner')
    expect(preview.blocks).toContain('no environment staging')
    expect(preview.blocks).not.toContain('compare confirm')
    parseAnswers.push({ ...bothRepos, intent: 'confirm' })
    await threadReply('yes')
    expect(posts.at(-1)!.blocks).toContain('Nothing can be compared yet')
    expect((await threadState())?.status).toBe('pending')
  })

  test('the same version on both sides is not compared', async () => {
    deployments[WIDGET] = [prodAt(WIDGET, 'v1.2.0')]
    parseAnswers.push({ ...bothRepos, repos: [`work:${WIDGET}`] })
    await mention('compare widget service between cert and prod')
    expect(posts[0]!.blocks).toContain('same version on both')
    expect(posts[0]!.blocks).not.toContain('compare confirm')
  })

  test('replies without a mention, replies in other threads and messages of bots are ignored', async () => {
    await deliver({
      type: 'message',
      channel: CHANNEL,
      channel_type: 'channel',
      user: 'U0123ALEX',
      text: 'yes',
      ts: '1700000300.000001',
      thread_ts: '1700000299.000001',
    })
    parseAnswers.push(bothRepos)
    await mention('compare both between cert and prod')
    await threadReply('yes', { bot_id: 'B0OTHER' })
    await plainReply('yes')
    await plainReply('what changed?')
    expect(posts).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  test('budget refusals and a missing provider are answered in the thread', async () => {
    failParse = new BudgetDeniedError([])
    await mention('compare both between cert and prod')
    expect(posts.at(-1)!.blocks).toContain('weekly AI budget is used up')
    withAgent = false
    await mention('compare both between cert and prod', { ts: '1700000400.000001' })
    expect(posts.at(-1)!.blocks).toContain('No AI provider is configured')
  })

  test('a comparison that fails for one repository still reports the others', async () => {
    parseAnswers.push(bothRepos)
    await mention('compare both between cert and prod')
    fakes[GADGET]!.forge.listCommits = async () => {
      throw new Error('forge is down')
    }
    parseAnswers.push({ ...bothRepos, intent: 'confirm' })
    await threadReply('go')
    const summary = posts.at(-1)!
    expect(summary.blocks).toContain('Comparison failed: forge is down')
    expect(summary.blocks).toContain('ABC-4')
  })

  test('a run left over by a stopped process can be confirmed again', async () => {
    parseAnswers.push(bothRepos)
    await mention('compare both between cert and prod')
    await compareThreads(store, () => NOW).update(CHANNEL, ROOT, (current) =>
      current
        ? {
            ...current,
            status: 'running',
            runId: 'gone',
            runningSince: '2026-11-03T08:00:00.000Z',
          }
        : undefined,
    )
    parseAnswers.push({ ...bothRepos, intent: 'confirm' })
    await threadReply('yes')
    expect((await threadState())?.status).toBe('done')
  })

  test('a reply while a run is fresh says it is still running', async () => {
    parseAnswers.push(bothRepos)
    await mention('compare both between cert and prod')
    await compareThreads(store, () => NOW).update(CHANNEL, ROOT, (current) =>
      current
        ? { ...current, status: 'running', runId: 'busy', runningSince: NOW.toISOString() }
        : undefined,
    )
    await threadReply('any news?')
    expect(posts.at(-1)!.blocks).toContain('Still comparing')
  })
})
