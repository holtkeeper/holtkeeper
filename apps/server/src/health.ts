import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { Store } from '@holtkeeper/store'

import type { Metrics } from './metrics.ts'

export interface ProbeOptions {
  /**
   * Reached with a cheap query; the stores migrate before their first query answers, and a store
   * with `ready()` (Postgres) is also asked whether its migrations are applied.
   */
  store: Pick<Store, 'jobs'>
  artifacts?: ArtifactStore
  /** `true` once shutdown started; readiness then fails so traffic moves elsewhere. */
  draining: () => boolean
  /** More named checks; a check fails by throwing. */
  checks?: Record<string, () => Promise<unknown>>
  /** Each check fails after this long. Default 3 seconds. */
  timeoutMs?: number
}

/** Liveness and readiness answers for orchestrators (Docker `HEALTHCHECK`, Kubernetes probes). */
export interface Probes {
  /** 200 while the process can answer at all. */
  live(): Response
  /** 200 when every check passes and the process is not draining, else 503; JSON body per check. */
  ready(): Promise<Response>
}

const withTimeout = <T>(promise: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Probes checking the store, the artifact store and the draining flag. */
export function createProbes(options: ProbeOptions): Probes {
  const timeoutMs = options.timeoutMs ?? 3000
  const store: Pick<Store, 'jobs'> & { ready?: () => Promise<void> } = options.store
  const checks: Record<string, () => Promise<unknown>> = {
    ...(typeof store.ready === 'function' && {
      migrations: () => store.ready?.() ?? Promise.resolve(),
    }),
    store: () => options.store.jobs.list({ limit: 1 }),
    ...(options.artifacts && {
      artifacts: () => options.artifacts?.ping() ?? Promise.resolve(),
    }),
    ...options.checks,
  }
  return {
    live: () => Response.json({ status: 'ok' }),
    async ready() {
      const results: Record<string, string> = {}
      await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
          try {
            await withTimeout(check(), timeoutMs)
            results[name] = 'ok'
          } catch (error) {
            results[name] = error instanceof Error ? error.message : String(error)
          }
        }),
      )
      const draining = options.draining()
      const ok = !draining && Object.values(results).every((result) => result === 'ok')
      return Response.json(
        { status: ok ? 'ok' : draining ? 'draining' : 'unavailable', checks: results },
        { status: ok ? 200 : 503 },
      )
    },
  }
}

const webhookPath = /^\/api\/webhooks\/([^/]+)/

/**
 * A `fetch` handler answering `GET /healthz`, `/readyz` and `/metrics` itself and passing every
 * other request to `next` (404 without one). Responses of `/api/webhooks/<forge>` are counted in
 * `metrics`. The operational paths need no authentication; keep `/metrics` off public ingresses.
 */
export function opsFetch(
  ops: { probes: Probes; metrics: Metrics },
  next?: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (pathname === '/healthz') return ops.probes.live()
      if (pathname === '/readyz') return ops.probes.ready()
      if (pathname === '/metrics') {
        return new Response(await ops.metrics.render(), {
          headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
        })
      }
    }
    if (!next) return Response.json({ error: 'not found' }, { status: 404 })
    const response = await next(request)
    const forge = webhookPath.exec(pathname)?.[1]
    if (forge && request.method === 'POST') ops.metrics.observeWebhook(forge, response.status)
    return response
  }
}
