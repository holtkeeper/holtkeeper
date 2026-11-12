import { describe, expect, test } from 'bun:test'

import { gitlab } from './gitlab.ts'
import type { FetchLike } from './http.ts'

const json = (body: unknown, status = 200) => Response.json(body, { status })

const own = 'https://hk.test/api/webhooks/r/abc'

type TestAnswers = Record<string, { status: number; message: string }>

function fakeGitLab(hooks: Record<string, unknown>[], answers: TestAnswers = {}) {
  const calls: string[] = []
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/v4\//, ''))
    const method = init.method ?? 'GET'
    calls.push(`${method} ${path}`)
    const match = /^projects\/(.+?)\/hooks(?:\/(\d+))?(?:\/test\/(\w+))?$/.exec(path)
    if (!match) return json({ message: '404 Not Found' }, 404)
    const [, , id, trigger] = match
    if (trigger) {
      const answer = answers[trigger]
      if (answer) return json({ message: answer.message }, answer.status)
      const hook = hooks.find((candidate) => candidate.id === Number(id))
      if (hook) Object.assign(hook, { alert_status: 'executable', disabled_until: null })
      return json({ message: '201 Created' }, 201)
    }
    if (!id) return json(hooks)
    const hook = hooks.find((candidate) => candidate.id === Number(id))
    return hook ? json(hook) : json({ message: '404 Not Found' }, 404)
  }
  const forge = gitlab({ url: 'https://gitlab.test', token: 't', fetch }).create()
  return { forge, calls }
}

const ref = { id: '7', scope: 'project' as const, target: 'games/libs' }

describe('gitlab webhook status', () => {
  test('reads each alert_status', async () => {
    const until = '2026-11-12T13:00:00.000Z'
    const cases = [
      [
        { alert_status: 'executable', disabled_until: null },
        { state: 'enabled', id: '7' },
      ],
      [
        { alert_status: 'temporarily_disabled', disabled_until: until },
        { state: 'temporarily_disabled', id: '7', disabledUntil: until },
      ],
      [
        { alert_status: 'disabled', disabled_until: null },
        { state: 'disabled', id: '7' },
      ],
      [{}, { state: 'enabled', id: '7' }],
      [
        { disabled_until: '2999-01-01T00:00:00.000Z' },
        { state: 'temporarily_disabled', id: '7', disabledUntil: '2999-01-01T00:00:00.000Z' },
      ],
    ] as const
    for (const [fields, expected] of cases) {
      const { forge } = fakeGitLab([{ id: 7, url: own, ...fields }])
      // oxlint-disable-next-line no-await-in-loop
      expect(await forge.webhookStatus?.(ref, own)).toEqual(expected)
    }
  })

  test('finds the hook by URL when the id is gone and never reports foreign hooks', async () => {
    const { forge } = fakeGitLab([
      { id: 3, url: 'https://other.test/hook', alert_status: 'disabled' },
      { id: 9, url: own, alert_status: 'disabled' },
    ])
    expect(await forge.webhookStatus?.(ref, own)).toEqual({ state: 'disabled', id: '9' })
    expect(await forge.webhookStatus?.({ ...ref, id: '3' }, own)).toEqual({
      state: 'disabled',
      id: '9',
    })
    const lonely = fakeGitLab([{ id: 3, url: 'https://other.test/hook', alert_status: 'disabled' }])
    expect(await lonely.forge.webhookStatus?.({ ...ref, id: '3' }, own)).toEqual({
      state: 'missing',
    })
  })

  test('re-enables with a test event the receiver ignores', async () => {
    const hooks = [{ id: 7, url: own, alert_status: 'disabled' }]
    const { forge, calls } = fakeGitLab(hooks)
    await forge.enableWebhook?.(ref)
    expect(calls).toEqual(['POST projects/games/libs/hooks/7/test/resource_access_token_events'])
    expect(await forge.webhookStatus?.(ref, own)).toEqual({ state: 'enabled', id: '7' })
  })

  test('falls back to a test push only when GitLab cannot build the other payloads', async () => {
    const { forge, calls } = fakeGitLab([{ id: 7, url: own, alert_status: 'disabled' }], {
      resource_access_token_events: { status: 400, message: 'trigger does not have a valid value' },
      releases_events: { status: 422, message: 'Ensure the project has releases.' },
    })
    await forge.enableWebhook?.(ref)
    expect(calls).toEqual([
      'POST projects/games/libs/hooks/7/test/resource_access_token_events',
      'POST projects/games/libs/hooks/7/test/releases_events',
      'POST projects/games/libs/hooks/7/test/push_events',
    ])
  })

  test('rejects when the test delivery fails without trying further triggers', async () => {
    const { forge, calls } = fakeGitLab([{ id: 7, url: own, alert_status: 'disabled' }], {
      resource_access_token_events: { status: 422, message: 'Hook execution failed' },
    })
    const failure = await forge.enableWebhook?.(ref).catch((error: unknown) => error)
    expect(String(failure)).toContain('422')
    expect(calls).toHaveLength(1)
  })
})
