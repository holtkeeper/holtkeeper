import { groupsMatch } from '@holtkeeper/access'
import type { AnyAnalyzer, ApplicabilityContext } from '@holtkeeper/analyzer'
import { type HoltkeeperConfig, resolveRepo } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import type { Job, JobStore } from '@holtkeeper/store'

import { cronError } from './cron.ts'
import { type JobRequest, enqueueUnique } from './enqueue.ts'
import { type ResolveRepos, groupRepositories, matchesRepoGlob } from './repos.ts'
import { nextRuns, runWindowEnd } from './smart.ts'

type Schedule = NonNullable<HoltkeeperConfig['jobs']>['schedules'][number]

/** What `scheduleProblems` checks of a schedule. */
export type CheckedSchedule = Pick<Schedule, 'name' | 'analyzers' | 'options'> &
  Partial<Pick<Schedule, 'cron' | 'every'>>

export interface SchedulerOptions {
  /**
   * Schedules come from `config.jobs.schedules`; groups from `config.groups`. Both are read again
   * on every tick, so a live config (e.g. `@holtkeeper/managed-config`) takes effect without restart.
   */
  config: HoltkeeperConfig
  store: { jobs: JobStore }
  /** Registry the schedules' analyzer kinds are looked up in. */
  analyzers: AnyAnalyzer[]
  /** Default: `groupRepositories(config)`, which lists repositories from the forge. */
  resolveRepos?: ResolveRepos
  /** Reads files for analyzers' `appliesTo` checks. Default: the forge clients of `config`. */
  forgeFor?: ForgeReaderFor
  now?: () => Date
  /** IANA zone for schedules without `timezone`. Default: the process's local zone. */
  timezone?: string
  /** How often `start` checks for due schedules. Default 30 seconds. */
  intervalMs?: number
  log?: (line: string) => void
}

/** Turns schedules into queued jobs. */
export interface Scheduler {
  /** Checks for due schedules every `intervalMs` until `stop`. Runs missed while stopped are skipped. */
  start(): void
  stop(): void
  /** Enqueues every schedule that came due since the previous tick; returns the new jobs. */
  tick(): Promise<Job[]>
  /**
   * Enqueues one schedule now (even a disabled one), skipping duplicates of queued or running
   * jobs. `actor` is the person who asked, recorded on the jobs.
   */
  run(name: string, options?: { actor?: string }): Promise<Job[]>
}

/** Every problem with the schedules: bad cron, unknown analyzers, invalid options. */
export function scheduleProblems(
  schedules: readonly CheckedSchedule[],
  analyzers: AnyAnalyzer[],
): string[] {
  const byKind = new Map(analyzers.map((analyzer) => [analyzer.kind, analyzer]))
  const problems: string[] = []
  for (const schedule of schedules) {
    const cron = schedule.cron === undefined ? undefined : cronError(schedule.cron)
    if (cron) problems.push(`schedule "${schedule.name}": ${cron}`)
    if (schedule.cron === undefined && schedule.every === undefined)
      problems.push(`schedule "${schedule.name}": needs cron or every`)
    for (const kind of schedule.analyzers) {
      const analyzer = byKind.get(kind)
      if (!analyzer) {
        problems.push(`schedule "${schedule.name}": unknown analyzer "${kind}"`)
        continue
      }
      const result = analyzer.options.safeParse(schedule.options?.[kind] ?? {})
      if (!result.success) {
        const issue = result.error.issues[0]
        const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
        problems.push(
          `schedule "${schedule.name}": options of ${kind}: ${where}${issue?.message ?? 'invalid'}`,
        )
      }
    }
  }
  return problems
}

/** Reads files of a forge's repositories, for `appliesTo` checks. */
export type ForgeReaderFor = (forgeId: string) => ApplicabilityContext['forge']

/** Every forge's client from the config, created once per forge. */
function configForgeReaders(config: HoltkeeperConfig): ForgeReaderFor {
  const clients = new Map<string, ApplicabilityContext['forge']>()
  return (forgeId) => {
    let client = clients.get(forgeId)
    if (!client) {
      const definition = config.forges[forgeId]
      if (!definition) throw new Error(`unknown forge "${forgeId}"`)
      client = definition.create()
      clients.set(forgeId, client)
    }
    return client
  }
}

/** A reader that fetches each file of a repository once, so checks of several analyzers share reads. */
function memoizedReader(forge: ApplicabilityContext['forge']): ApplicabilityContext['forge'] {
  const files = new Map<string, Promise<string | undefined>>()
  return {
    readFile(repo, file, ref) {
      const key = `${repo}\0${file}\0${ref ?? ''}`
      let read = files.get(key)
      if (!read) {
        read = forge.readFile(repo, file, ref)
        files.set(key, read)
      }
      return read
    },
  }
}

/**
 * The jobs one schedule produces: repo-scope analyzers once per repository of the schedule's
 * groups (every group when it names none) that matches its `repos` globs and the analyzer's
 * `appliesTo` (a failing check counts as applying), group-scope analyzers once per group with
 * `repo` = `{ forge, path: <group> }`.
 */
export async function planSchedule(
  schedule: Pick<Schedule, 'analyzers' | 'groups' | 'repos' | 'options'> &
    Partial<Pick<Schedule, 'name'>>,
  {
    config,
    analyzers,
    resolveRepos,
    forgeFor = configForgeReaders(config),
    log = () => {},
  }: {
    config: HoltkeeperConfig
    analyzers: readonly Pick<AnyAnalyzer, 'kind' | 'scope' | 'appliesTo'>[]
    resolveRepos: ResolveRepos
    /** Default: the forge clients of `config`. */
    forgeFor?: ForgeReaderFor
    log?: (line: string) => void
  },
): Promise<JobRequest[]> {
  const byKind = new Map(analyzers.map((analyzer) => [analyzer.kind, analyzer]))
  const entries = schedule.groups ?? Object.keys(config.groups)
  const selected = schedule.analyzers.flatMap((kind) => {
    const analyzer = byKind.get(kind)
    return analyzer ? [analyzer] : []
  })
  const optionsOf = (kind: string) => schedule.options?.[kind] ?? {}
  const requests: JobRequest[] = []

  if (selected.some((analyzer) => analyzer.scope === 'repo')) {
    const repos = new Map<string, RepoRef>()
    for (const entry of entries) {
      const [first = '', ...rest] = typeof entry === 'string' ? [entry] : entry
      for (const repo of await resolveRepos(first)) {
        if (schedule.repos && !schedule.repos.some((pattern) => matchesRepoGlob(pattern, repo)))
          continue
        if (rest.length && !groupsMatch([entry], resolveRepo(config, repo).groups)) continue
        repos.set(`${repo.forge}:${repo.path}`, repo)
      }
    }
    const readers = new Map<string, ApplicabilityContext['forge']>()
    const readerOf = (repo: RepoRef) => {
      const key = `${repo.forge}:${repo.path}`
      let reader = readers.get(key)
      if (!reader) {
        reader = memoizedReader(forgeFor(repo.forge))
        readers.set(key, reader)
      }
      return reader
    }
    const applies = async (analyzer: (typeof selected)[number], repo: RepoRef) => {
      if (!analyzer.appliesTo) return true
      try {
        return await analyzer.appliesTo({ repo, forge: readerOf(repo) })
      } catch (error) {
        log(
          `${analyzer.kind} on ${repo.forge}:${repo.path}: applicability check failed, queued anyway: ${error instanceof Error ? error.message : String(error)}`,
        )
        return true
      }
    }
    for (const analyzer of selected.filter((a) => a.scope === 'repo')) {
      let skipped = 0
      for (const repo of repos.values()) {
        // oxlint-disable-next-line no-await-in-loop -- one repository after another keeps rate limits
        if (!(await applies(analyzer, repo))) {
          skipped++
          continue
        }
        requests.push({
          analyzer: analyzer.kind,
          repo,
          options: optionsOf(analyzer.kind),
          trigger: 'schedule',
          ...(schedule.name ? { schedule: schedule.name } : {}),
        })
      }
      if (skipped)
        log(
          `${analyzer.kind}: ${skipped} repositor${skipped === 1 ? 'y does' : 'ies do'} not use it`,
        )
    }
  }

  for (const analyzer of selected.filter((a) => a.scope === 'group')) {
    for (const group of entries.filter((entry) => typeof entry === 'string')) {
      const forge = config.groups[group]?.forge
      if (!forge) continue
      requests.push({
        analyzer: analyzer.kind,
        repo: { forge, path: group },
        group,
        options: optionsOf(analyzer.kind),
        trigger: 'schedule',
        ...(schedule.name ? { schedule: schedule.name } : {}),
      })
    }
  }
  return requests
}

/**
 * Gives the repository jobs of one run start times spread evenly from `start` to `end`, one slot
 * per repository (all analyzers of a repository share it), in the order the repositories appear.
 * Group jobs and a single repository start at `start`.
 */
export function spreadRequests(requests: JobRequest[], start: Date, end: Date): JobRequest[] {
  const repoKeys = [
    ...new Set(
      requests.filter((r) => r.group === undefined).map((r) => `${r.repo.forge}:${r.repo.path}`),
    ),
  ]
  const span = Math.max(0, end.getTime() - start.getTime())
  const step = repoKeys.length > 0 ? span / repoKeys.length : 0
  const slot = new Map(repoKeys.map((key, index) => [key, index]))
  return requests.map((request) => {
    const index =
      request.group === undefined ? slot.get(`${request.repo.forge}:${request.repo.path}`) : 0
    const runAfter = new Date(start.getTime() + Math.floor((index ?? 0) * step))
    return { ...request, runAfter: runAfter.toISOString() }
  })
}

/**
 * Creates a scheduler for `config.jobs.schedules`; throws when a schedule is invalid at creation.
 * Schedules that become invalid later (a live config) are skipped and logged once per version.
 * Due times come from `nextRuns`, so windows, time zones and jitter apply; `spread` schedules give
 * their repository jobs `runAfter` times across `runWindowEnd`.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { config, store, analyzers, timezone } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const resolveRepos = options.resolveRepos ?? groupRepositories(config)
  const schedules = () => config.jobs?.schedules ?? []
  const problems = scheduleProblems(schedules(), analyzers)
  if (problems.length) throw new Error(`invalid job schedules:\n${problems.join('\n')}`)
  const reported = new Set<string>()
  const zone = timezone ? { timezone } : {}

  let lastCheck = now()
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<Job[]> | undefined

  const run = async (schedule: Schedule, at = now(), actor?: string) => {
    let requests = await planSchedule(schedule, {
      config,
      analyzers,
      resolveRepos,
      ...(options.forgeFor && { forgeFor: options.forgeFor }),
      log: (line) => log(`schedule ${schedule.name}: ${line}`),
    })
    if (actor) requests = requests.map((request) => ({ ...request, actor }))
    if (schedule.spread) requests = spreadRequests(requests, at, runWindowEnd(schedule, at, zone))
    const { enqueued, skipped } = await enqueueUnique(store.jobs, requests, now().toISOString())
    log(
      `schedule ${schedule.name}: ${enqueued.length} job(s) queued${skipped.length ? `, ${skipped.length} already pending` : ''}`,
    )
    return enqueued
  }

  const valid = (schedule: Schedule) => {
    const found = scheduleProblems([schedule], analyzers)
    if (!found.length) return true
    const key = JSON.stringify(schedule)
    if (!reported.has(key)) {
      reported.add(key)
      log(`schedule ${schedule.name} skipped: ${found.join('; ')}`)
    }
    return false
  }

  const tick = async () => {
    const at = now()
    const since = lastCheck
    lastCheck = at
    const created: Job[] = []
    for (const schedule of schedules()) {
      if (!schedule.enabled || !valid(schedule)) continue
      const due = nextRuns(schedule, since, 1, zone)[0]
      if (!due || due > at) continue
      try {
        created.push(...(await run(schedule, due)))
      } catch (error) {
        log(
          `schedule ${schedule.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return created
  }

  return {
    start() {
      if (timer) return
      lastCheck = now()
      timer = setInterval(() => {
        if (ticking) return
        ticking = tick().finally(() => {
          ticking = undefined
        })
      }, options.intervalMs ?? 30_000)
    },
    stop() {
      clearInterval(timer)
      timer = undefined
    },
    tick,
    async run(name, runOptions = {}) {
      const schedule = schedules().find((s) => s.name === name)
      if (!schedule) throw new Error(`unknown schedule "${name}"`)
      return run(schedule, now(), runOptions.actor)
    },
  }
}
