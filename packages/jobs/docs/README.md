# @holtkeeper/jobs

The task engine: schedules and triggers become queued jobs in the `JobStore`; a worker claims them, prepares exactly what each analyzer needs and stores the result as an `AnalysisRecord`.

```ts
import { createJobEngine } from '@holtkeeper/jobs'

const engine = createJobEngine({ config, store, analyzers, agentFor, onFinished })
await engine.start() // scheduler + worker
await engine.stop() // running jobs are aborted and go back to the queue
```

Everything is injected (store, clock, repository resolver, context factory, runner), so the pieces are tested with `memoryStore()` and fake analyzers.

## Config

```ts
jobs: {
  concurrency: 2, // jobs at once; one repository never runs two jobs at once
  cacheDir: '.holtkeeper/cache', // bare mirrors, see @holtkeeper/workspace
  timeoutMinutes: 30,
  schedules: [
    {
      name: 'nightly',
      cron: '0 3 * * *', // croner syntax, evaluated in the process's time zone
      analyzers: ['depgraph', 'quality'],
      groups: ['games'], // default: every group
      repos: ['work:games/*'], // optional forge:path globs
      options: { depgraph: { depth: 2 } }, // per analyzer kind
    },
  ],
  onTag: { analyzers: ['changelog'], groups: ['games'] }, // used by the server's forge webhooks
  webhookSecret: env('HOLTKEEPER_WEBHOOK_SECRET'),
  execution: { mode: 'container', network: 'install' }, // see "Execution and toolchains"
}
```

`@holtkeeper/core` checks the shape of cron strings; `createScheduler` parses them with croner and also rejects unknown analyzer kinds and invalid schedule options.

## Smart schedules

A schedule has exactly one of `cron` and `every`, and may limit when it runs:

```ts
{
  name: 'office',
  title: 'Office hours', // display name
  enabled: true, // default; disabled schedules stay in the config but never run
  every: '1h', // or cron: '0 3 * * 1-5'
  timezone: 'Europe/Berlin', // IANA; default the server's zone
  windows: {
    allow: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' }],
    deny: [{ days: ['fri'], from: '12:00', to: '13:00' }],
    skipWeekends: true,
    skipNights: { from: '22:00', to: '07:00' },
    holidays: ['2026-12-24'], // local dates
  },
  jitterMinutes: 10, // stable 0..10 min delay per run
  spread: true, // spread repository jobs over the run window
  analyzers: ['quality'],
}
```

`nextRuns(schedule, from, count, { timezone? })` is the pure function behind it; it returns the next `count` run times strictly after `from`:

- All times are local to the schedule's zone, so a `0 3 * * *` run stays at 03:00 across DST changes (croner evaluates cron in the zone).
- A window whose `to` is not after `from` runs past midnight and belongs to the day it starts (`fri 22:00–02:00` covers Saturday 01:00). With `allow` windows a minute must be in one of them; `deny`, `skipNights`, `skipWeekends` and `holidays` always win.
- A cron run that falls into a denied minute **moves to the next allowed minute**; several runs that collapse onto the same minute run once (an hourly cron with `skipNights 22–07` runs at 07:00 once, then hourly).
- `every` intervals start at the first allowed minute of each allowed stretch of a local day and repeat every interval of elapsed time while still allowed (`workHours` with `1h`: 09:00, 10:00, …, 17:00). Alignment restarts at local midnight. On the spring DST day a `1h` schedule runs at 00:00, 01:00, 03:00; in autumn the repeated hour runs twice. Whole-day intervals (`1d`, `2d`) run at the first allowed minute of every n-th local day.
- Jitter is derived from the schedule name and the run time, so previews and real runs agree; it is dropped when it would leave the allowed time.
- About 400 days ahead without an allowed minute, it returns fewer runs.

`isAllowedAt(schedule, at)` tells whether a minute is allowed; `runWindowEnd(schedule, at)` is the end of the allowed stretch a run starts in, capped by the next run and 24 hours. `schedulePresets.workHours({ every?, from?, to?, days? })`, `.nightly({ at?, weekends? })` (default 03:00 Monday to Friday) and `.weekly({ day?, at? })` return timings to spread into a schedule.

The scheduler re-reads `config.jobs.schedules` on every tick (so a live config from `@holtkeeper/managed-config` takes effect without restart), skips disabled ones, and skips (logging once) schedules that became invalid after start. A due `spread` schedule gives its repository jobs `runAfter` times evenly between the run and `runWindowEnd` (`spreadRequests`); group jobs start at once.

## Scheduler

`createScheduler({ config, store, analyzers, resolveRepos?, now?, timezone?, intervalMs? })` checks every 30 s which schedules came due (by `nextRuns`) since the last check (runs missed while stopped are not caught up). Per schedule:

- repo-scope analyzers: one job per repository of the schedule's groups that matches `repos`;
- group-scope analyzers: one job per group, with `repo = { forge, path: <group> }` and `group` set.

Jobs already queued or running for the same analyzer, repository and ref are skipped (`enqueueUnique`). `resolveRepos` defaults to `groupRepositories(config)`: it lists each include glob's static prefix with `GitForge.listRepositories`, reads includes without wildcards (exact repository paths) with `GitForge.getRepository` instead of listing them as namespaces, filters by the group's include/exclude globs and skips archived repositories. `run(name)` enqueues one schedule now; `tick()` is exposed for tests.

## Worker

`createWorker({ store, analyzers, contextFor, concurrency, timeoutMs, now, settingOptions?, onFinished? })`:

1. On `start`, running jobs whose heartbeat is older than `staleMs` (2 min) are requeued (or failed when out of attempts). Then it claims jobs up to `concurrency`, polling every 5 s.
2. Options: shallow merge, later wins — the analyzer's schema defaults, the job's options when it came from a schedule/tag/webhook (schedule options), `settingOptions(job)` (the server resolves the scoped setting `analyzers.<kind>`), then the job's options for manual jobs. The merged result is validated with the analyzer's `options`; invalid options or an unknown analyzer fail the job without retry.
3. `contextFor(job, analyzer, { signal, log, options })` builds the `AnalyzerContext`.
4. The run gets an `AbortSignal` that fires on timeout, on `stop`, or when a heartbeat (every 15 s) finds the job canceled. Log lines go to `appendLog` (the job keeps the last 200).
5. Success stores an `AnalysisRecord` (`kind` = the analyzer's analysis kind, `repo`, `ref` = the analyzer's returned ref or the job's, `actor`) and completes the job. Failures retry after `exponentialBackoff` (1 min doubling, at most 1 h) until `maxAttempts`. `onFinished(job, record?)` fires for successes and final failures. Artifacts an analyzer returns (`run` → `{ data, artifacts? }`) go to the optional `persistArtifacts(artifacts, { repo, kind, analysisId })` hook right after the record is stored; a failing hook is written to the job log and does not fail the job.

`runNext()` claims and runs one job to the end, for tests and one-off runs.

`maxJobs` limits how many jobs the worker claims in its life; `exhausted` resolves once they all ended (one job per process or pod). `drain(timeoutMs)` is the graceful stop: no more claims, claimed jobs still waiting for admission are requeued at once, running jobs get `timeoutMs` to finish and are then aborted and requeued; it resolves with `{ finished, requeued }`. `stop()` aborts at once. `running` is the number of jobs claimed and not ended. `createJobEngine({ worker: { concurrency, maxJobs, workerId } })` overrides the worker settings of `config.jobs` for one process.

## Context

`createContextFactory({ config, store, cacheDir, runner?, agentFor?, resolveRepos?, checkout?, gitKeyFor?, workDir?, toolchainFor?, createRunner?, detectToolchain? })` gives each analyzer what its `needs` ask for:

| Need / member         | Provided                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `checkout` (repo)     | `dir`: a worktree of the job's ref, or the default branch                                         |
| `forge`               | the repository's `GitForge`                                                                       |
| `agent`               | `agentFor(repo)`; a missing `required` agent fails the job                                        |
| `history`             | `{ analyses, auditRuns }` from the store                                                          |
| group scope           | `repos`: the group's repositories                                                                 |
| `requiredCheckouts()` | `checkouts`: `forge:path` → dir for each extra repository the analyzer asks for                   |
| always                | `checkout(repo, { ref?, writable? })` for on-demand checkouts, e.g. one per repository of a group |

Every checkout uses `@holtkeeper/workspace` with the forge's `gitCredentials?()` and is a private worktree (so writable and read-only checkouts are made the same way). All checkouts, including on-demand ones the analyzer did not clean up, are removed after the run.

`gitKeyFor(forgeId)` returns the forge's SSH key (`ForgeGitKey`: private and public key, usage, pinned `knownHosts`, commit `identity`), or `undefined`. A key with `auth` usage and pinned host keys makes the checkout clone, fetch and push over SSH; without host keys git stays on HTTPS. A key with `signing` usage and an identity signs the checkout's commits, and on-demand checkouts then carry a `publisher` (`commit`, `push`) that propagate and port use to publish signed commits over git instead of the forge API. The server wires it to the SSH keys panel forges issue.

Checkouts returned by `context.checkout(...)` also carry a `runner` for commands in that checkout (see below). If the job's signal is already aborted when the context is ready, everything prepared is released and the context rejects.

## Execution and toolchains

`jobs.execution` decides where analyzer commands run (`context.runner`):

```ts
execution: {
  mode: 'container', // 'host' (default) | 'mise' | 'container'
  image: 'holtkeeper-worker:latest', // default; build it from docker/worker
  engine: 'docker', // default: docker when installed, else podman
  limits: { cpus: 2, memory: '4g', pids: 1024 },
  network: 'install', // 'none' | 'install' (default) | 'full'
  user: '10001:10001', // default: the image's holtkeeper user
}
```

- **`host`** (default, also when `execution` is missing): every runner is the host runner, exactly as before.
- **`mise`**: commands run on the host as `mise exec <tools> -- <command>` (`localMiseRunner`); tools are installed when the runner starts. For development.
- **`container`**: one sandboxed container per checkout (`containerRunner` from `@holtkeeper/exec-container`): read-only root, no capabilities, non-root, resource limits, network per policy, tools installed by mise into a shared cache volume. See [docker/worker](../../../docker/worker/README.md) for the image and the security model.

For each checkout the factory runs `detectToolchain` (`@holtkeeper/toolchain`) on it, applies the scoped `toolchain` setting for that repository (`toolchainFor(repo)`, wired by the server; it can override tool versions, `image`, `network` and add `env`) with `mergeToolchain`, logs the tools and detection notes to the job log, and builds the runner with `createRunner`:

| Checkout                                     | Runner                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| the job's checkout (`needs.checkout`)        | `context.runner`; started before `run`, stopped in `cleanup` before the checkout is removed     |
| `requiredCheckouts()`                        | mounted read-only into the job's runner at `/checkouts/<n>`                                     |
| `context.checkout(...)` (e.g. group members) | its own `runner` on the returned object, started on its first command, stopped with `cleanup()` |
| none (forge-only or group analyzers)         | `context.runner` stays the host runner                                                          |

Git (clones, worktrees) always runs on the host runner with the forge credentials; containers never see them. A runner that fails to start fails the job (and is retried like any other failure). The `toolchain` setting definition is exported as `toolchainSetting` (with `toolchainOverrideSchema`); the server registers it via `executionSettings()` in `apps/server/src/jobs.ts`. `runnerFactory`, `createRunner` and `startOnFirstRun` are exported for other hosts such as the CLI.
