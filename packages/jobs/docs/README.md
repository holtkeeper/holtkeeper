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

`concurrency`, `prioritySlots`, `cacheDir`, `timeoutMinutes`, `execution` and `webhookSecret` come from the config file; `schedules` and the `on*` triggers from panel documents (see [@holtkeeper/managed-config](../../managed-config/docs/README.md)). The effective `jobs` section looks like this:

```ts
jobs: {
  concurrency: 2, // jobs at once
  prioritySlots: 1, // extra slots only interactive jobs (review) take; 0 turns them off
  cacheDir: '.holtkeeper/cache', // bare mirrors, see @holtkeeper/workspace
  timeoutMinutes: 30,
  schedules: [
    {
      name: 'nightly',
      cron: '0 3 * * *', // croner syntax, evaluated in the process's time zone
      analyzers: ['depgraph', 'quality'],
      groups: ['games'], // default: every root group
      repos: ['work:games/*'], // optional forge:path globs
      options: { depgraph: { depth: 2 } }, // per analyzer kind
    },
  ],
  onTag: { analyzers: ['api-surface'], groups: ['games'] }, // used by the server's forge webhooks
  onPush: { analyzers: ['ci-jobs'], branches: ['main', 'release/*'] }, // branch pushes, webhooks or polling
  onNewRepo: { exclude: ['coverage'] }, // first listing of a repository: every read-only analyzer, see the server docs
  webhookSecret: env('HOLTKEEPER_WEBHOOK_SECRET'),
  execution: { mode: 'container', network: 'install' }, // see "Execution and toolchains"
}
```

`@holtkeeper/core` checks the shape of cron strings; `createScheduler` parses them with croner and skips (and logs once) schedules with invalid options or no analyzer the server still has, and leaves an unknown analyzer kind out of a schedule that names others (logged once), so a schedule stored in the panel for an analyzer that was removed never stops the server and keeps running its other analyzers. `scheduleProblems` stays strict for the panel's validation.

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

Inside the package, `isAllowedAt(schedule, at)` tells whether a minute is allowed (freshness uses it for the night window) and `runWindowEnd(schedule, at)` is the end of the allowed stretch a run starts in, capped by the next run and 24 hours.

The scheduler re-reads `config.jobs.schedules` on every tick (so a live config from `@holtkeeper/managed-config` takes effect without restart), skips disabled ones, and skips (logging once) schedules that became invalid after start. A due `spread` schedule gives its repository jobs `runAfter` times evenly between the run and `runWindowEnd` (`spreadRequests`); group jobs start at once.

## Scheduler

`createScheduler({ config, store, analyzers, resolveRepos?, now?, timezone?, intervalMs? })` checks every 30 s which schedules came due (by `nextRuns`) since the last check (runs missed while stopped are not caught up). Per schedule:

- repo-scope analyzers: one job per repository of the schedule's groups that matches `repos`; an intersection entry (`['frontend', 'storefront']`) lists the repositories of its first group and keeps those in all of them; an analyzer with `appliesTo` gets jobs only for the repositories it applies to, checked through the forge on every run (file reads are shared between the schedule's analyzers, a failing check counts as applying, skipped repositories are logged), so repositories that start or stop using what it works on join or leave without config changes. `SchedulerOptions.skip(analyzer, repo)` (also `JobEngineOptions.skip` and `planSchedule`'s `skip`) leaves a repository out of one analyzer's jobs before `appliesTo` is checked, logged as left out by settings; the server uses it for coverage on repositories with no tests by design. `forgeFor` replaces the forge clients these checks read through;
- group-scope analyzers: one job per single-group entry, with `repo = { forge, path: <group> }` and `group` set.

A schedule without `groups` covers every root group (`rootGroups`), so a subgroup never gets a second group-scope run of the same analyzer; a subgroup named in `groups` gets its own. The server's freshness sweep, unlike schedules, targets every group, subgroups included, with group-scope analyzers.

Jobs already queued or running for the same analyzer, repository and ref are skipped (`enqueueUnique`). With `{ dailyLimits }` (`dailyLimitsOf(analyzers)`, from each analyzer's `dailyLimit`) a request whose UTC day already holds that many jobs of its kind (counted by `runAfter`, canceled ones left out) gets `runAfter` at the start of the next day with room; the scheduler, the new-repository trigger and **Run now** pass it. `resolveRepos` defaults to `groupRepositories(config)`: it lists each include glob's static prefix with `GitForge.listRepositories`, reads includes without wildcards (exact repository paths) with `GitForge.getRepository` instead of listing them as namespaces, filters by the group's include/exclude globs and skips archived repositories. A subgroup is never listed itself: its root group is, and the members `resolveRepo` puts in the subgroup are kept. `run(name, { actor? })` enqueues one schedule now (also a disabled one), recording `actor` on the jobs; `tick()` is exposed for tests. Every job a schedule queues carries its `schedule` name, so `scheduleRuns(jobs, limit)` can group a schedule's jobs into runs (jobs queued together share `createdAt`), newest first, with counts per status, analyzers, who started it by hand, first start, last end once nothing is pending, and up to five failures.

## Freshness

`decideFreshness(input, { now, nightWindow, timezone, debounceMs? })` decides one analyzer on one target from its `refresh` (see [@holtkeeper/analyzer](../../analyzer/docs/README.md#freshness)), the latest record (`sha`, `createdAt`), the default-branch head and when it was first seen, whether a job is queued or running, the last freshness job and the team's mode. It returns `run` with a reason (`sha 1a2b3c4 != head 5d6e7f8`, `record has no sha, head …`, `no record yet`, `cadence 7d elapsed`), `wait` (stale or due, but held back; `nextAt` when known), `fresh` (`nextAt` for time-class analyzers) or `skip`. In order:

- `off` mode skips; an active job waits;
- `change`: an unknown head waits; the record of the head is fresh; an analyzer that may call an LLM (`ai`) skips without a record naming a commit; `pathsChanged: false` is fresh; a head younger than the debounce (`FRESHNESS_DEBOUNCE_MS`, 30 minutes) waits; `minInterval` counts from the record;
- `time`: due once `cadence` passed since the record, or without one;
- `slower` multiplies interval and cadence by `factor` (`refreshIntervalMs`);
- a freshness job that ended without success holds the next try back by the interval;
- `heavy` waits for the night window (`inNightWindow`, `from > to` crosses midnight).

`matchesAnyPath(files, globs)` checks changed files against `refresh.paths`. The server's sweeper supplies heads, caps and budgets (see the [server docs](../../../apps/server/docs/README.md#freshness)).

## Worker

`createWorker({ store, analyzers, contextFor, concurrency, timeoutMs, now, pools?, settingOptions?, onFinished?, onCanceled? })`:

1. On `start` and then every `staleMs`, running jobs whose heartbeat is older than `staleMs` (2 min) are requeued (or failed when out of attempts), so a job whose worker was killed (out of memory, a lost node) runs again even when that worker restarted before the job went stale. Then it claims jobs up to `concurrency`, polling every 5 s. Claims follow the `ClaimRules` of its analyzers: `Analyzer.exclusive` (the run pushes branches, commits or opens merge requests) makes a job run alone on its `repo`, and `Analyzer.after` lists kinds whose jobs of the same repository queued ahead of it must end first, for analyzers that read their results from `history`. Jobs of other analyzers of one repository run in parallel; one analyzer never runs twice at once on one repository. With `claimDelayMs` the worker claims only jobs queued at least that long (`ClaimRules.delayMs`), so workers without a delay take new jobs first and it gets what they leave; keep the delay above their poll interval. Jobs of `Analyzer.interactive` kinds (`ClaimRules.priority`, the `review` analyzer) are claimed before every other due job and ignore `claimDelayMs`; when every regular slot is busy the worker still claims up to `prioritySlots` (default 1) more of them into express slots, which other jobs never take, so a merge request review starts at once however long the queue. They still take a free regular slot first. Only a running exclusive or `after` job of their repository holds them back; one merely queued ahead of them does not, so an exclusive job waiting its turn deep in the queue never delays a review. The pool, same-analyzer and exclusive-self rules hold. With an `admission` hook, claimed jobs wait for a slot in claim order: a freed slot goes to the oldest waiting job the hook admits. With a `cancelReason` hook, an admitted job for which it returns a reason is canceled before its analyzer starts, with the reason in its log (a hook that throws lets it run); the server uses it to drop reviews queued before a repository turned them off.
2. Options: shallow merge, later wins — the analyzer's schema defaults, the job's options when it came from a schedule/tag/webhook (schedule options), `settingOptions(job)` (the server resolves the scoped setting `analyzers.<kind>`), then the job's options for manual jobs. The merged result is validated with the analyzer's `options`; invalid options or an unknown analyzer fail the job without retry.
3. `contextFor(job, analyzer, { signal, log, step, options })` builds the `AnalyzerContext` (the default factory marks its `checkout` and `toolchain` steps).
4. The run gets an `AbortSignal` that fires on timeout, on `stop`, or when a heartbeat (every 15 s) finds the job canceled. Log lines go to the attempt's log (see [Job logs](#job-logs)); the worker wraps preparing the context, running the analyzer and storing the result in the steps `prepare`, `analyze` and `store`, and hands `context.step` to the analyzer for steps of its own. A failed attempt records the innermost step whose error ended it (`JobStore.fail({ step })`, kept in `Job.attemptsHistory`).
5. Success stores an `AnalysisRecord` (`kind` = the analyzer's analysis kind, `repo`, `ref` = the analyzer's returned ref or the job's, `sha` = the analyzer's returned sha or the commit of the job's checkout (`PreparedContext.sha`), `actor`, `createdAt` = the analyzer's returned `at`, such as a release's tag date, or the time of the run, `metrics` = the kind's metrics from `recordMetrics` of [`@holtkeeper/analyzer`](../../analyzer/docs/README.md#metrics) with the merged options and the previous record of the same line, left out when the kind defines none or cannot read the data) and completes the job; for an analyzer with `keepRecords` it then prunes the repository's older records of that kind (`AnalysisStore.prune`). Failures retry after `exponentialBackoff` (1 min doubling, at most 1 h) until `maxAttempts`. A run a spend limit stopped (`isBudgetStop`: an error named `BudgetExceededError` in the error's `cause` chain, as `@holtkeeper/agent` and `@holtkeeper/ai-usage` throw) is `blocked` instead: no retry, not a failure. `onFinished(job, record?)` fires for successes, final failures (also a job stale recovery fails for good after its worker died) and blocked jobs; `onCanceled(job)` fires for a job the worker stopped as canceled, by `cancelReason` before it ran or by a cancel while it ran. Analyzers get the job's id as `context.jobId`. Artifacts an analyzer returns (`run` → `{ data, artifacts? }`) go to the optional `persistArtifacts(artifacts, { repo, kind, analysisId })` hook right after the record is stored; a failing hook is written to the job log and does not fail the job.

`runNext()` claims and runs one job to the end, for tests and one-off runs.

### Worker pools

`Analyzer.pool` assigns an analyzer's jobs to a worker pool; analyzers without one are in `DEFAULT_POOL` (`default`). `pools` (default `['default']`) are the pools a worker serves, and it never claims jobs of the others: a worker serving `default` claims everything but the kinds of other pools (`ClaimRules.except`), a worker serving only named pools claims only their kinds (`ClaimRules.only`, so jobs of unknown analyzers stay queued for the default workers to fail). `write-task` is in pool `write`: regular workers leave write tasks queued until a worker started with `serve --pool write` (or `--pool default,write` for a single process) takes them.

### Job logs

Each attempt has its own log in an `ArtifactStore` (`WorkerOptions.logs`, `JobEngineOptions.logs`; the server passes its artifact store, so in the cluster logs go to S3; without one they stay in process memory). `createJobLog(store, { jobId, attempt, flushLines?, flushMs?, maxLines?, now?, onError? })` buffers lines and stores a chunk of JSON lines every `flushLines` (100) lines or `flushMs` (1 s) after the first buffered line, on `flush()` and on `close()`; the worker closes the log before it records how the attempt ended. Each chunk is an artifact behind the ref `job-logs/<job>/<attempt>/<index>` (meta `first`, `count`); the ref `job-logs/<job>/<attempt>/head` holds `chunks`, `lines`, `complete` and `marks` (the step marks of the stored lines as JSON, at most 400). A chunk that fails to store is kept for the next flush and reported to `onError`; `close()` tries the last chunk up to three times; storing a log never fails a job. Beyond `maxLines` (50,000) one notice replaces the rest.

A `JobLogLine` is `{ n, at, text, level?: 'error', step?, mark?: 'start' | 'end' | 'fail', ms? }`. `log.step(name, run)` writes a `start` mark, tags lines written meanwhile with the innermost running step, then an `end` mark with the duration, or a `fail` mark (level `error`) when `run` throws; `failedStep` is the innermost step whose error ended the run, a step failing with a new error after an earlier one was caught replaces it.

`readJobLog(store, jobId, attempt, { offset?, limit?, tail? })` returns a `JobLogPage { total, offset, lines, complete, steps }`: from `offset` (default 0, up to `limit`, default 500, at most `MAX_LOG_PAGE` = 2000) or the last `tail` lines. It finds the first chunk by a binary search over the chunk refs, so a page of a large log costs a few small reads. `steps` are every step of the attempt whatever page was read, folded from the head's marks by `stepsOf`: `JobStep { name, depth, line, startedAt, status: 'running' | 'succeeded' | 'failed', ms? }` in start order; a mark without its start is ignored, a step without an end stays `running`. An attempt without a stored log reads as empty.

### Claim rules and wait reasons

`claimRulesOf(analyzers, delayMs?, pools?)` builds the `ClaimRules` the worker claims under from the analyzers' `exclusive`, `after`, `pool` and `interactive` (as `priority`). `waitReasons(job, queue, rules, now)` says why a queued job is not claimed yet, mirroring `JobStore.claim` over the queued and running jobs in `queue`: `JobWait { reasons, ahead }` with reasons `retry` / `scheduled` (`runAfter` in the future), `same-analyzer`, `exclusive-self` (an exclusive job waits for running ones), `exclusive` and `after` (an exclusive job or a kind it reads runs or, for a non-priority job, is queued ahead on the same target), and `ahead`, the due queued jobs before it in claim order (priority kinds first). A per-pool claim delay and a job waiting for a worker of its pool are not visible there. `describeWaitReason` renders one reason as a sentence.

`maxJobs` limits how many jobs the worker claims in its life; `exhausted` resolves once they all ended (one job per process or pod). `drain(timeoutMs)` is the graceful stop: no more claims, claimed jobs still waiting for admission (express ones included) are requeued at once, running jobs get `timeoutMs` to finish and are then aborted and requeued; it resolves with `{ finished, requeued }`. `stop()` aborts at once. `running` is the number of jobs claimed and not ended. `createJobEngine({ worker: { concurrency, claimDelayMs, maxJobs, workerId, pools } })` overrides the worker settings of `config.jobs` for one process.

### Worker registry

Workers announce themselves in one KV key, `WORKERS_KEY` (`workers`), holding `{ [workerId]: lastSeen }`. The engine passes `store.kv` as `WorkerOptions.registry`; a started worker calls `touchWorker(kv, id, now)` on `start` and every `heartbeatMs`, and `removeWorker` on `stop` and `drain`. `touchWorker` goes through `updateKv` of `@holtkeeper/store`: it reads the map, adds its own entry, drops entries older than the TTL and writes back with `compareAndSet`, retrying when another worker wrote in between, so concurrent workers never lose each other's entries (a KV without `compareAndSet` writes once). `liveWorkers(kv, now, ttlMs?)` lists workers seen within `WORKER_TTL_MS` (90 s), most recently seen first, and leaves stale entries out even before a write prunes them. There is no per-worker key and no prefix listing. Registry failures are logged and never stop a worker.

The server's `GET /api/jobs/stats` and the `queue_stats` tool read the registry for the worker list and combine it with `JobStore.count` (live queued and running, failed and blocked of the last 24 hours), the `startedAt - runAfter` claim latency of recently started jobs, `waitReasons` over the oldest queued jobs and the AI usage of running jobs (see the [server docs](../../../apps/server/docs/README.md#jobs-and-webhooks)).

## Context

`createContextFactory({ config, store, cacheDir, runner?, agentFor?, resolveRepos?, checkout?, gitKeyFor?, readOnly?, workDir?, toolchainFor?, createRunner?, detectToolchain?, egressEnv?, jobEnv?, cache? })` gives each analyzer what its `needs` ask for:

| Need / member         | Provided                                                                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout` (repo)     | `dir`: a worktree of the job's ref, or the default branch                                                                                                                                                                                                                     |
| `forge`               | the repository's `GitForge`                                                                                                                                                                                                                                                   |
| `forgeAccess`         | `{ kind, url, token, fetch?, signing?, readOnly }` from the forge definition (`fetch` carries its rate limits), `gitKeyFor` and `readOnly`                                                                                                                                    |
| `agent`               | `agentFor(repo, { jobId, analyzer, actor?, interactive, subject?, runner })`, `interactive` for `manual` and `command` jobs, `subject` the job's `title` option, `MR !<mergeRequest>`, `version` option or `ref`, first that is set; a missing `required` agent fails the job |
| `history`             | `{ analyses, auditRuns }` from the store                                                                                                                                                                                                                                      |
| group scope           | `repos`: the group's repositories                                                                                                                                                                                                                                             |
| `requiredCheckouts()` | `checkouts`: `forge:path` → dir for each extra repository the analyzer asks for                                                                                                                                                                                               |
| always                | `checkout(repo, { ref?, writable? })` for on-demand checkouts, e.g. one per repository of a group                                                                                                                                                                             |
| `cache` option        | `cache`: a `RunCache` shared by all runs (`createJobEngine({ cache })`; the server's is S3/fs)                                                                                                                                                                                |

Every checkout uses `@holtkeeper/workspace` with the forge's `gitCredentials?()` and is a private worktree (so writable and read-only checkouts are made the same way). All checkouts, including on-demand ones the analyzer did not clean up, are removed after the run.

`gitKeyFor(forgeId)` returns the forge's SSH key (`ForgeGitKey`: private and public key, usage, pinned `knownHosts`, commit `identity`), or `undefined`. A key with `auth` usage and pinned host keys makes the checkout clone, fetch and push over SSH; without host keys git stays on HTTPS. A key with `signing` usage and an identity signs the checkout's commits, and on-demand checkouts then carry a `publisher` (`commit`, `push`) that propagate uses to publish signed commits over git instead of the forge API. The server wires it to the SSH keys panel forges issue. Checkouts of repositories `readOnly(repo)` reports get no `publisher`, so nothing is pushed to them over git (`createJobEngine` passes `readOnly` through).

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
  egress: { url: 'http://egress-proxy:8080', caFile: '/etc/egress/ca.crt' }, // optional
  envAllowlist: ['GOPROXY'], // extra worker variables job commands keep
}
```

- **`host`** (default, also when `execution` is missing): every runner is the host runner, exactly as before.
- **`mise`**: commands run on the host (in Kubernetes: the worker pod) as `mise exec <tools> -- <command>` (`localMiseRunner`); tools are installed when the runner starts. Commands keep only allowlisted variables of the worker's environment (`defaultLocalEnvAllowlist` plus `envAllowlist`), never `HOLTKEEPER_*`, so they do not inherit the server's secrets; see the exec-container docs for what this does not cover.
- **`container`**: one sandboxed container per checkout (`containerRunner` from `@holtkeeper/exec-container`): read-only root, no capabilities, non-root, resource limits, network per policy, tools installed by mise into a shared cache volume. See [docker/worker](../../../docker/worker/README.md) for the image and the security model.

`egress` routes the HTTP(S) traffic of every command in `mise` and `container` mode through a forward proxy (`egressEnvironment` of `@holtkeeper/exec-container`; the CA files are mounted at `/etc/holtkeeper/egress` in containers). The scoped `toolchain` setting's `env` wins over the proxy variables. The job log names the proxy's `host:port`, never credentials in its URL.

Behind a proxy every command also gets `GOTOOLCHAIN=local` (no toolchain download; `GOFLAGS` stays unset because Go refuses `-mod=mod` in `go.work` checkouts, so analyzers that run per module set it themselves), plus whatever `egressEnv()` returns (an option of `createContextFactory`, `createJobEngine` and `runnerFactory`, read for every runner and only when `egress` is set; a failure is logged and skipped). The server passes `GOPRIVATE` there, computed from the panel GitLab forges and their groups (`host/<top group>`, or the whole host), so `go` fetches those modules directly through the proxy, which adds the forge token to git and `go get` requests, instead of `proxy.golang.org` and the checksum database (`GOPRIVATE` implies `GONOPROXY` and `GONOSUMDB`). The job log shows the `GOPRIVATE` value. Analyzers that run `go` (coverage, depgraph-go, vuln-go) inherit all of it. The toolchain setting's `env` still wins. Never return secrets from `egressEnv`: commands and logs see it.

`jobEnv()` (an option of the same three) is read for every runner in `mise` and `container` mode, with or without `egress`, and its variables win over `egressEnv` (the toolchain setting's `env` still wins over both; a failure is logged as `job environment: …` and skipped). The server passes `GOPRIVATE` there: the egress patterns joined with every private Go module pattern (forge hosts, top-level groups and namespaces on public hosts, the `libraries.goPrivate` setting), so `go` in jobs never asks `proxy.golang.org` or `sum.golang.org` about private modules, behind a proxy or not. The job log shows the `GOPRIVATE` value. Host mode builds no runner and gets neither.

For each checkout the factory runs `detectToolchain` (`@holtkeeper/toolchain`) on it, applies the scoped `toolchain` setting for that repository (`toolchainFor(repo)`, wired by the server; it can override tool versions, `image`, `network` and add `env`) with `mergeToolchain`, logs the tools and detection notes to the job log, and builds the runner with `createRunner`:

| Checkout                                     | Runner                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| the job's checkout (`needs.checkout`)        | `context.runner`; started before `run`, stopped in `cleanup` before the checkout is removed     |
| `requiredCheckouts()`                        | mounted read-only into the job's runner at `/checkouts/<n>`                                     |
| `context.checkout(...)` (e.g. group members) | its own `runner` on the returned object, started on its first command, stopped with `cleanup()` |
| none (forge-only or group analyzers)         | `context.runner` stays the host runner                                                          |

Git (clones, worktrees) always runs on the host runner with the forge credentials; containers never see them. A runner that fails to start fails the job (and is retried like any other failure). The `toolchain` setting definition is exported as `toolchainSetting` (with `toolchainOverrideSchema`); the server registers it via `executionSettings()` in `apps/server/src/jobs.ts`. `runnerFactory`, `createRunner` and `startOnFirstRun` are exported for other hosts such as the CLI.
