/**
 * What one server process does:
 * - `web`: HTTP API, UI and webhooks; no worker, no scheduler.
 * - `worker`: the job worker, plus a small HTTP server for `/healthz`, `/readyz` and `/metrics`.
 * - `scheduler`: schedules, credential rotation, artifact retention and other sweeps, run only
 *   while this process holds the leader lease; plus the small HTTP server.
 * - `all`: everything (the scheduler duties still under the leader lease).
 */
export type Role = 'web' | 'worker' | 'scheduler' | 'all'

const roles: readonly Role[] = ['web', 'worker', 'scheduler', 'all']

/** What a role turns on. */
export interface RoleDuties {
  /** `api`: the full HTTP application; `probes`: only health and metrics endpoints. */
  http: 'api' | 'probes'
  worker: boolean
  /** Schedules and sweeps, under the leader lease. */
  scheduler: boolean
}

/**
 * Parses `--role` / `HOLTKEEPER_ROLE`: one role or several joined by commas (`web,scheduler` runs
 * the API and the leader-elected scheduler in one process). `undefined` and `''` mean `all`.
 * Throws on unknown roles.
 */
export function parseRoles(value: string | undefined): Role[] {
  if (value === undefined || value.trim() === '') return ['all']
  return [
    ...new Set(
      value.split(',').map((part) => {
        const role = roles.find((candidate) => candidate === part.trim())
        if (!role) throw new Error(`unknown role "${part.trim()}"; expected ${roles.join(', ')}`)
        return role
      }),
    ),
  ]
}

const dutiesOf: Record<Role, RoleDuties> = {
  web: { http: 'api', worker: false, scheduler: false },
  worker: { http: 'probes', worker: true, scheduler: false },
  scheduler: { http: 'probes', worker: false, scheduler: true },
  all: { http: 'api', worker: true, scheduler: true },
}

/** What a set of roles turns on together: the union of their duties. */
export function roleDuties(selected: readonly Role[]): RoleDuties {
  const all = selected.map((role) => dutiesOf[role])
  return {
    http: all.some((duties) => duties.http === 'api') ? 'api' : 'probes',
    worker: all.some((duties) => duties.worker),
    scheduler: all.some((duties) => duties.scheduler),
  }
}
