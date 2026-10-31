import { describe, expect, test } from 'bun:test'

import { gitlab } from './gitlab.ts'
import { hookBody } from './hooks.ts'
import type { FetchLike } from './http.ts'

interface Hook {
  id: number
  url: string
  [key: string]: unknown
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** A tiny GitLab with hooks for `groups/games` (unless `free`) and projects. */
function fakeGitLab({ free = false } = {}) {
  const hooks = new Map<string, Hook[]>()
  const calls: string[] = []
  let nextId = 1
  const projects = [
    { path_with_namespace: 'games/a' },
    { path_with_namespace: 'games/b' },
    { path_with_namespace: 'games/old', archived: true },
  ]
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/v4\//, ''))
    const method = init.method ?? 'GET'
    calls.push(`${method} ${path}`)
    if (path === 'groups/games/projects') return json(projects)
    const match = /^(groups|projects)\/(.+?)\/hooks(?:\/(\d+))?$/.exec(path)
    if (!match) return json({ message: '404 Not Found' }, 404)
    const [, kind, target, id] = match
    if (kind === 'groups' && free) return json({ message: '404 Not Found' }, 404)
    const key = `${kind}/${target}`
    const list = hooks.get(key) ?? []
    hooks.set(key, list)
    if (method === 'GET') return json(list)
    const body: Record<string, unknown> = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    if (method === 'POST') {
      const hook: Hook = { ...body, id: nextId++, url: String(body.url) }
      list.push(hook)
      return json(hook, 201)
    }
    const index = list.findIndex((hook) => hook.id === Number(id))
    if (index < 0) return json({ message: '404 Not Found' }, 404)
    if (method === 'PUT') {
      const current = list[index]
      if (current) list[index] = { ...current, ...body, id: current.id, url: current.url }
      return json(list[index])
    }
    list.splice(index, 1)
    return new Response(null, { status: 204 })
  }
  const forge = gitlab({ url: 'https://gitlab.test', token: 't', fetch }).create()
  return { forge, hooks, calls }
}

const spec = {
  url: 'https://hk.test/api/webhooks/work',
  secret: 's1',
  events: ['merge_request', 'note', 'pipeline'] as const,
}

describe('gitlab webhooks', () => {
  test('hookBody switches every event explicitly', () => {
    expect(hookBody({ ...spec, events: ['tag_push'] })).toEqual({
      url: spec.url,
      token: 's1',
      enable_ssl_verification: true,
      push_events: false,
      tag_push_events: true,
      merge_requests_events: false,
      note_events: false,
      confidential_note_events: false,
      issues_events: false,
      confidential_issues_events: false,
      pipeline_events: false,
      job_events: false,
      deployment_events: false,
      releases_events: false,
      wiki_page_events: false,
      milestone_events: false,
      member_events: false,
      emoji_events: false,
      feature_flag_events: false,
      resource_access_token_events: false,
    })
  })

  test('group hooks are idempotent by URL and rotate the secret in place', async () => {
    const { forge, hooks } = fakeGitLab()
    const first = await forge.ensureWebhook?.(
      { group: 'games' },
      { ...spec, events: [...spec.events] },
    )
    expect(first).toEqual({ id: '1', hooks: [{ id: '1', scope: 'group', target: 'games' }] })
    const second = await forge.ensureWebhook?.(
      { group: 'games' },
      { ...spec, secret: 's2', events: [...spec.events] },
    )
    expect(second?.id).toBe('1')
    expect(hooks.get('groups/games')).toHaveLength(1)
    expect(hooks.get('groups/games')?.[0]?.token).toBe('s2')
    await forge.removeWebhook?.(second?.hooks ?? [])
    await forge.removeWebhook?.(second?.hooks ?? [])
    expect(hooks.get('groups/games')).toEqual([])
  })

  test('falls back to project hooks without group hooks', async () => {
    const { forge, hooks } = fakeGitLab({ free: true })
    const result = await forge.ensureWebhook?.(
      { group: 'games' },
      { ...spec, events: [...spec.events] },
    )
    expect(result?.hooks.map((hook) => `${hook.scope}:${hook.target}`)).toEqual([
      'project:games/a',
      'project:games/b',
    ])
    expect(result?.fallback).toContain('2 project hook(s)')
    expect(hooks.get('projects/games/a')?.[0]?.merge_requests_events).toBeTrue()
  })

  test('project targets get a project hook', async () => {
    const { forge } = fakeGitLab()
    const result = await forge.ensureWebhook?.(
      { project: 'games/a' },
      { ...spec, events: [...spec.events] },
    )
    expect(result?.hooks).toEqual([{ id: '1', scope: 'project', target: 'games/a' }])
    expect(forge.ensureWebhook?.({}, { ...spec, events: [] })).rejects.toThrow('group or a project')
  })
})
