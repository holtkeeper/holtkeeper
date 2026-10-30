import { type Clock, systemClock } from '@holtkeeper/limits'
import type { KvStore } from '@holtkeeper/store'

/** Something only the leader runs; started on election, stopped when the lease is lost. */
export type LeaderDuty = () => (() => void | Promise<void>) | Promise<() => void | Promise<void>>

export interface LeaderElectionOptions {
  /** Must implement `acquireLease` (and should implement `releaseLease`). */
  kv: Pick<KvStore, 'acquireLease' | 'releaseLease'>
  /** Lease key. Default `leader:scheduler`. */
  key?: string
  /** This process; default a random id. */
  holder?: string
  /** Lease lifetime. Default 30 seconds. */
  ttlMs?: number
  /** How often the lease is renewed (or a takeover attempted). Default a third of `ttlMs`. */
  renewMs?: number
  duties: LeaderDuty[]
  clock?: Clock
  log?: (line: string) => void
}

/** A running election; see `startLeaderElection`. */
export interface LeaderElection {
  readonly holder: string
  /** Whether this process currently holds the lease and runs the duties. */
  readonly leading: boolean
  /** One renewal round now; resolves with `leading`. Rounds also run every `renewMs`. */
  check(): Promise<boolean>
  /** Stops the duties, releases the lease and stops renewing. */
  stop(): Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Elects one leader among the processes sharing a store: each round tries to take or renew the
 * lease; the holder runs `duties` until a renewal fails or comes back held by someone else, then
 * stops them. A process that dies loses the lease after `ttlMs`, when another contender takes it.
 * A failing store round counts as lost, so two leaders never knowingly overlap past one lease.
 */
export function startLeaderElection(options: LeaderElectionOptions): LeaderElection {
  const { kv } = options
  if (!kv.acquireLease)
    throw new Error('leader election needs a store whose kv implements acquireLease')
  const key = options.key ?? 'leader:scheduler'
  const holder =
    options.holder ?? `${process.env.HOSTNAME ?? 'holtkeeper'}-${crypto.randomUUID().slice(0, 8)}`
  const ttlMs = options.ttlMs ?? 30_000
  const renewMs = options.renewMs ?? Math.max(1, Math.floor(ttlMs / 3))
  const clock = options.clock ?? systemClock
  const log = options.log ?? (() => {})
  let stops: (() => void | Promise<void>)[] = []
  let leading = false
  let stopped = false
  let cancel: (() => void) | undefined
  let round: Promise<boolean> | undefined

  const startDuties = async () => {
    for (const duty of options.duties) {
      try {
        stops.push(await duty())
      } catch (error) {
        log(`leader: a duty failed to start: ${messageOf(error)}`)
      }
    }
  }

  const stopDuties = async () => {
    const current = stops
    stops = []
    for (const stop of current.toReversed()) {
      try {
        await stop()
      } catch (error) {
        log(`leader: a duty failed to stop: ${messageOf(error)}`)
      }
    }
  }

  const once = async () => {
    let held = false
    try {
      const lease = await kv.acquireLease?.(key, holder, ttlMs / 1000, new Date(clock.now()))
      held = lease?.holder === holder
    } catch (error) {
      log(`leader: lease ${key} check failed: ${messageOf(error)}`)
    }
    if (stopped) return false
    if (held && !leading) {
      leading = true
      log(`leader: ${holder} took ${key}`)
      await startDuties()
    } else if (!held && leading) {
      leading = false
      log(`leader: ${holder} lost ${key}`)
      await stopDuties()
    }
    return leading
  }

  const check = () => {
    round ??= once().finally(() => {
      round = undefined
    })
    return round
  }

  const schedule = () => {
    if (stopped) return
    cancel = clock.setTimer(() => {
      void check().finally(schedule)
    }, renewMs)
  }

  void check().finally(schedule)

  return {
    holder,
    get leading() {
      return leading
    },
    check,
    async stop() {
      stopped = true
      cancel?.()
      await round
      if (leading) {
        leading = false
        await stopDuties()
      }
      await kv.releaseLease?.(key, holder).catch(() => false)
    },
  }
}
