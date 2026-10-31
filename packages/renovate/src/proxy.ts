import type { ForgeFetch } from '@holtkeeper/forge'

/** A running `startForgeProxy`. */
export interface ForgeProxy {
  /** Origin to point the tool at, e.g. `http://127.0.0.1:41234`. */
  origin: string
  /** Requests forwarded so far. */
  readonly requests: number
  stop(): Promise<void>
}

const dropRequest = new Set(['host', 'connection', 'content-length', 'accept-encoding'])
// `fetch` hands the body over decoded, so length and encoding of the upstream answer no longer apply.
const dropResponse = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'keep-alive',
])

/**
 * Serves `target` (an origin such as `https://gitlab.example.com`) on a loopback port and sends
 * every request there through `fetch`, so a tool's API calls draw from the same per-token limits
 * as Holtkeeper's own forge client. Requests pass through as they are, credentials included; the
 * proxy adds none. Absolute URLs in `Link` and `Location` headers are rewritten to the proxy, so
 * pagination and redirects stay on it. A failing upstream call answers 502.
 */
export function startForgeProxy(input: { target: string; fetch: ForgeFetch }): ForgeProxy {
  const target = new URL(input.target).origin
  let requests = 0
  let origin = ''
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const incoming = new URL(request.url)
      const headers = new Headers()
      for (const [name, value] of request.headers)
        if (!dropRequest.has(name.toLowerCase())) headers.set(name, value)
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      requests += 1
      let upstream: Response
      try {
        upstream = await input.fetch(`${target}${incoming.pathname}${incoming.search}`, {
          method: request.method,
          headers,
          redirect: 'manual',
          signal: request.signal,
          ...(hasBody && { body: await request.arrayBuffer() }),
        })
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 502 })
      }
      const answer = new Headers()
      for (const [name, value] of upstream.headers) {
        const lower = name.toLowerCase()
        if (dropResponse.has(lower)) continue
        answer.append(
          name,
          lower === 'link' || lower === 'location' ? value.replaceAll(target, origin) : value,
        )
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: answer,
      })
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  return {
    origin,
    get requests() {
      return requests
    },
    stop: () => server.stop(true),
  }
}
