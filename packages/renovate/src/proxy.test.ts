import { afterEach, expect, test } from 'bun:test'

import type { ForgeFetch } from '@holtkeeper/forge'

import { type ForgeProxy, startForgeProxy } from './proxy.ts'

const servers: { stop(force?: boolean): unknown }[] = []
let proxy: ForgeProxy | undefined
afterEach(async () => {
  await proxy?.stop()
  proxy = undefined
  for (const server of servers.splice(0)) server.stop(true)
})

function upstream() {
  const seen: { method: string; path: string; auth: string | null; body: string }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      seen.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        auth: request.headers.get('private-token'),
        body: await request.text(),
      })
      if (url.pathname === '/api/v4/projects')
        return new Response(Bun.gzipSync(JSON.stringify([{ id: 1 }])), {
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            link: `<${url.origin}/api/v4/projects?page=2>; rel="next", <${url.origin}/api/v4/projects?page=9>; rel="last"`,
          },
        })
      if (url.pathname === '/moved')
        return new Response(null, { status: 302, headers: { location: `${url.origin}/api/v4/x` } })
      return Response.json({ ok: true }, { status: 201 })
    },
  })
  servers.push(server)
  return { origin: `http://127.0.0.1:${server.port}`, seen }
}

test('forwards requests through the given fetch and rewrites pagination to the proxy', async () => {
  const target = upstream()
  const calls: string[] = []
  const limited: ForgeFetch = (input, init) => {
    calls.push(input)
    return fetch(input, init)
  }
  proxy = startForgeProxy({ target: `${target.origin}/api/v4/`, fetch: limited })

  const list = await fetch(`${proxy.origin}/api/v4/projects?per_page=100`, {
    headers: { 'private-token': 'glpat-secret' },
  })
  expect(await list.json()).toEqual([{ id: 1 }])
  expect(list.headers.get('link')).toBe(
    `<${proxy.origin}/api/v4/projects?page=2>; rel="next", <${proxy.origin}/api/v4/projects?page=9>; rel="last"`,
  )

  const created = await fetch(`${proxy.origin}/api/v4/merge_requests`, {
    method: 'POST',
    headers: { 'private-token': 'glpat-secret', 'content-type': 'application/json' },
    body: '{"title":"Update"}',
  })
  expect(created.status).toBe(201)

  const moved = await fetch(`${proxy.origin}/moved`, { redirect: 'manual' })
  expect(moved.headers.get('location')).toBe(`${proxy.origin}/api/v4/x`)

  expect(target.seen.map((r) => [r.method, r.path, r.auth, r.body])).toEqual([
    ['GET', '/api/v4/projects?per_page=100', 'glpat-secret', ''],
    ['POST', '/api/v4/merge_requests', 'glpat-secret', '{"title":"Update"}'],
    ['GET', '/moved', null, ''],
  ])
  expect(calls).toHaveLength(3)
  expect(proxy.requests).toBe(3)
})

test('answers 502 when the upstream call fails, e.g. the limiter denies it', async () => {
  proxy = startForgeProxy({
    target: 'https://gitlab.example.com',
    fetch: () => Promise.reject(new Error('daily limit reached')),
  })
  const answer = await fetch(`${proxy.origin}/api/v4/version`)
  expect(answer.status).toBe(502)
  expect(await answer.text()).toBe('daily limit reached')
})
