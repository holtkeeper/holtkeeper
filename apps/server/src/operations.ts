import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { Limiter } from '@holtkeeper/limits'
import type { Store } from '@holtkeeper/store'

import { type Probes, createProbes, opsFetch } from './health.ts'
import { type LeaderDuty, type LeaderElection, startLeaderElection } from './leader.ts'
import { type Metrics, createMetrics } from './metrics.ts'
import type { RoleDuties } from './roles.ts'

export interface OperationsOptions {
  duties: RoleDuties
  store: Store
  artifacts?: ArtifactStore
  limiter?: Limiter
  /** Run only by the leader among processes with the scheduler role. */
  leaderDuties: LeaderDuty[]
  /** Lease timing; see `LeaderElectionOptions`. */
  leader?: { ttlMs?: number; renewMs?: number; holder?: string }
  log: (line: string) => void
}

/** Health, metrics, draining state and the leader election of one server process. */
export interface Operations {
  probes: Probes
  metrics: Metrics
  /** Present when this process has the scheduler role and the store supports leases. */
  leader?: LeaderElection
  readonly draining: boolean
  /** The listener's `fetch`: probes and metrics first, then `app` (404 without it). */
  fetch(
    app?: (request: Request) => Response | Promise<Response>,
  ): (request: Request) => Promise<Response>
  /** Marks the process draining (readiness fails from now on). */
  startDraining(): void
  /** Stops the leader duties and releases the lease. */
  stop(): Promise<void>
}

/** Sets up probes and metrics and, for the scheduler role, starts the leader election. */
export function startOperations(options: OperationsOptions): Operations {
  const { duties, store, log } = options
  let draining = false
  const probes = createProbes({
    store,
    ...(options.artifacts && { artifacts: options.artifacts }),
    draining: () => draining,
  })
  const metrics = createMetrics({
    store,
    ...(options.limiter && { limiter: options.limiter }),
    ...(options.artifacts && { artifacts: options.artifacts }),
    cluster: duties.http === 'api',
    draining: () => draining,
  })

  let leader: LeaderElection | undefined
  let stopUnelected: (() => Promise<void>) | undefined
  if (duties.scheduler && options.leaderDuties.length) {
    if (store.kv?.acquireLease) {
      leader = startLeaderElection({
        kv: store.kv,
        duties: options.leaderDuties,
        log,
        ...options.leader,
      })
    } else {
      log(
        'leader: the store has no leases; running scheduler duties without election (one process only)',
      )
      const started = Promise.all(options.leaderDuties.map(async (duty) => duty()))
      stopUnelected = async () => {
        for (const stop of await started) await stop()
      }
    }
  }

  return {
    probes,
    metrics,
    ...(leader && { leader }),
    get draining() {
      return draining
    },
    fetch: (app) => opsFetch({ probes, metrics }, app),
    startDraining() {
      draining = true
    },
    async stop() {
      await leader?.stop()
      await stopUnelected?.()
    },
  }
}
