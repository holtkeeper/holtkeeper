import type { ArtifactStoreView, SystemHealth, SystemHealthCheck } from '@holtkeeper/api'
import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { Store } from '@holtkeeper/store'

import type { ServerDeps } from './context.ts'
import { lastLibraryRun, librariesConfigOf, librariesEnabled } from './libraries.ts'
import { libraryProgress } from './library-progress.ts'
import type { Metrics } from './metrics.ts'
import { retiredReadOnlyEntries } from './read-only.ts'
import { workerStorageReports } from './storage-reports.ts'
import { storageHistory, storageOverview, weekAgoSnapshot } from './storage.ts'

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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** `undefined` when `check` settles within `ms`, else its error message. */
const failureOf = (check: () => Promise<unknown>, ms: number) =>
  withTimeout(check(), ms).then(
    () => undefined,
    (error: unknown) => messageOf(error),
  )

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

/**
 * The release this process runs: `version` (else `HOLTKEEPER_VERSION`) trimmed, `undefined` when
 * empty, so an image built without a version reports none.
 */
export const releaseVersion = (version?: string): string | undefined =>
  (version ?? Bun.env.HOLTKEEPER_VERSION)?.trim() || undefined

/**
 * The `warn` check listing stored `repo.readOnly: true` entries, which no longer stop writes;
 * `undefined` when there are none.
 */
export async function retiredReadOnlyCheck(
  store: Pick<Store, 'settings'>,
): Promise<SystemHealthCheck | undefined> {
  const leftover = await retiredReadOnlyEntries(store)
  if (leftover.length === 0) return undefined
  return {
    id: 'retired-read-only',
    label: 'Read-only entries',
    status: 'warn',
    detail: `${leftover.length} retired repo.readOnly ${leftover.length === 1 ? 'entry no longer protects its' : 'entries no longer protect their'} repositories: set them again as repo.freeze`,
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

const answering = (
  id: SystemHealthCheck['id'],
  label: string,
  error: string | undefined,
): SystemHealthCheck => ({
  id,
  label,
  status: error === undefined ? 'ok' : 'error',
  detail: error ?? 'answering',
})

const worst = (checks: readonly SystemHealthCheck[]): SystemHealth['status'] =>
  checks.some((check) => check.status === 'error')
    ? 'error'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'ok'

async function libraryCheck(
  deps: Pick<ServerDeps, 'store'>,
): Promise<SystemHealthCheck | undefined> {
  const { store } = deps
  if (!store.libraries || !librariesEnabled(await librariesConfigOf(store.settings)))
    return undefined
  const base = { id: 'library-index', label: 'Library index' } as const
  const progress = await libraryProgress(store.kv)
  if (progress?.waitingUntil)
    return {
      ...base,
      status: 'warn',
      detail: `waiting for GitHub quota, ${progress.done} of ${progress.total}`,
    }
  if (progress)
    return { ...base, status: 'ok', detail: `indexing ${progress.done} of ${progress.total}` }
  const last = await lastLibraryRun(store.kv)
  if (last?.error) return { ...base, status: 'warn', detail: `last run failed: ${last.error}` }
  return { ...base, status: 'ok', detail: last ? 'idle' : 'not run yet' }
}

/**
 * Where `artifacts` keeps its data (never credentials), how much it holds, the operator's
 * declared `quotaBytes` and `server.retention`; `undefined` for a store without a location
 * (memory). A failed or slow measurement leaves out the figures and sets `error`.
 */
async function artifactStoreView(
  artifacts: ArtifactStore,
  server: ServerDeps['config']['server'],
  timeoutMs: number,
): Promise<ArtifactStoreView | undefined> {
  const { location } = artifacts
  if (!location) return undefined
  const quotaBytes = server?.artifacts?.quotaBytes
  const retention = server?.retention
  const base: ArtifactStoreView = {
    ...location,
    ...(quotaBytes ? { quotaBytes } : {}),
    ...(retention && (retention.days || retention.maxBytes)
      ? {
          retention: {
            ...(retention.days ? { days: retention.days } : {}),
            ...(retention.maxBytes ? { maxBytes: retention.maxBytes } : {}),
          },
        }
      : {}),
  }
  try {
    const usage = await withTimeout(artifacts.usage(), timeoutMs)
    const totals = usage.objects ?? usage
    return { ...base, usedBytes: totals.bytes, objects: totals.count }
  } catch (error) {
    return { ...base, error: messageOf(error) }
  }
}

/**
 * Settings › System at a glance: whether the store answers and its migrations are applied, the
 * artifact store answers, workers report and the library index runs, plus storage now against the
 * newest daily snapshot at least seven days old and the artifact store's view
 * (`artifactStoreView`). Each check fails after `timeoutMs` (default 3 s).
 */
export async function systemHealth(
  deps: Pick<ServerDeps, 'store' | 'artifacts' | 'storage' | 'version' | 'now' | 'config'>,
  options: { startedAt: string; timeoutMs?: number },
): Promise<SystemHealth> {
  const now = deps.now()
  const timeoutMs = options.timeoutMs ?? 3000
  const store: Store & { ready?: () => Promise<void> } = deps.store
  const [
    storeError,
    migrationsError,
    artifactsError,
    reports,
    library,
    overview,
    history,
    retired,
    artifactStore,
  ] = await Promise.all([
    failureOf(() => store.jobs.list({ limit: 1 }), timeoutMs),
    typeof store.ready === 'function'
      ? failureOf(() => store.ready?.() ?? Promise.resolve(), timeoutMs)
      : Promise.resolve(undefined),
    deps.artifacts
      ? failureOf(() => deps.artifacts?.ping() ?? Promise.resolve(), timeoutMs)
      : Promise.resolve(undefined),
    store.kv ? workerStorageReports(store.kv, { now }) : Promise.resolve([]),
    libraryCheck(deps).catch((error: unknown): SystemHealthCheck => ({
      id: 'library-index',
      label: 'Library index',
      status: 'error',
      detail: messageOf(error),
    })),
    storageOverview({ providers: deps.storage ?? [], kv: store.kv, now }),
    storageHistory(store.kv),
    retiredReadOnlyCheck(store).catch(() => undefined),
    deps.artifacts
      ? artifactStoreView(deps.artifacts, deps.config.server, timeoutMs)
      : Promise.resolve(undefined),
  ])
  const checks: SystemHealthCheck[] = [
    answering('store', 'Store', storeError),
    ...(typeof store.ready === 'function'
      ? [
          {
            id: 'migrations',
            label: 'Migrations',
            status: migrationsError === undefined ? 'ok' : 'error',
            detail: migrationsError ?? 'up to date',
          } satisfies SystemHealthCheck,
        ]
      : []),
    ...(deps.artifacts ? [answering('artifacts', 'Artifacts', artifactsError)] : []),
    ...(store.kv
      ? [
          {
            id: 'workers',
            label: 'Workers',
            status: reports.length ? 'ok' : 'warn',
            detail: reports.length
              ? `${reports.length} ${reports.length === 1 ? 'worker' : 'workers'} reporting`
              : 'no worker reported in 15 minutes',
          } satisfies SystemHealthCheck,
        ]
      : []),
    ...(library ? [library] : []),
    ...(retired ? [retired] : []),
  ]
  const past = weekAgoSnapshot(history, now)
  return {
    status: worst(checks),
    checks,
    checkedAt: now.toISOString(),
    storage: {
      totalBytes: overview.totalBytes,
      ...(past && { since: past.day, weekAgoBytes: past.bytes, weekAgo: past.areas }),
    },
    ...(artifactStore && { artifactStore }),
    workers: reports.length,
    ...(deps.version?.trim() && { version: deps.version.trim() }),
    startedAt: options.startedAt,
  }
}
