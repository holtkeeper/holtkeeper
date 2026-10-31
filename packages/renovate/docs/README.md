# @holtkeeper/renovate

Runs [Renovate](https://docs.renovatebot.com) inside Holtkeeper: no separate deployment, no `renovate.json` needed in repositories. The `analyzers.renovate` setting is the configuration, the job engine runs Renovate per repository, and every run is stored as a `renovate` analysis: outdated dependencies, Renovate merge requests with their pipelines, deprecated packages and the problems Renovate logged. The server joins these records with browserslist and propagation into one overview of the fleet (`GET /api/dependency-updates`, the **Dependency updates** page).

The browserslist database stays with [@holtkeeper/browserslist](../../browserslist/docs/README.md): Renovate can only refresh `caniuse-lite`, a transitive dependency, by refreshing the whole lockfile, while the browserslist analyzer updates it alone and lists the browsers the targets gained or lost.

## Analyzer

`renovateAnalyzer` — kind `renovate`, scope `repo`, `exclusive`, needs `forge` and `forgeAccess` (the forge token, see [@holtkeeper/analyzer](../../analyzer/docs/README.md#forge-access)). `createRenovateAnalyzer({ command?, now? })` replaces how Renovate is started. The default schedule `renovate-nightly` of [@holtkeeper/managed-config](../../managed-config/docs/README.md#defaults) runs it on weekday nights in every group.

1. Builds the config (`renovateConfig`): Renovate's platform and API endpoint for the forge (`renovatePlatform`: GitLab `…/api/v4/`, GitHub.com or GitHub Enterprise `…/api/v3/`), the one repository, `onboarding: false`, `requireConfig` from `repoConfig`, a file report and a private `baseDir`, `binarySource: global`, `allowScripts: false`, then the repository options of the setting (`repositoryConfig`) and the raw `config` last. Without `merge-requests` mode, and always for read-only repositories, the run is `dryRun: lookup`: Renovate clones and looks up, but pushes nothing.
2. Runs Renovate `RENOVATE_VERSION` (44.164.10) with `mise exec node@24 -- npx --yes renovate@…` (`defaultRenovateCommand`) on the job's host runner. The token (`RENOVATE_TOKEN`) and the signing key (`RENOVATE_GIT_PRIVATE_KEY`) go through the environment, never into the config file; every `HOLTKEEPER_*` variable of the worker is removed (`renovateEnv`). With a forge signing key, commits carry the key's identity and are signed with it (`platformCommit: disabled`).
3. Routes Renovate's API calls through Holtkeeper's rate limits: when the forge gives its `fetch` (`ForgeAccess.fetch`, the one with the per-token limiter), `startForgeProxy` serves the API origin on a loopback port for the length of the run and Renovate's `endpoint` points there. Every call queues with the token's other users, waits out its 429 cool-downs and is counted in `apiRequests`. The proxy forwards requests as they are and adds no credentials; it rewrites `Link` and `Location` headers so pagination stays on it. A host rule in `RENOVATE_HOST_RULES` keeps the token on lookups against the real host, as Renovate would give it without the proxy.
4. Reads the report (`parseRenovateReport`): per manager the files and declared dependencies, every update with its type (`major`, `minor`, `patch`, `digest`, …), whether it fixes a vulnerability or waits for `releaseAgeDays`, deprecated and abandoned packages, Renovate's branches and the libyears it computed. Warnings and errors Renovate logged become `problems`.
5. Lists Renovate merge requests through the forge: open ones and those merged or closed in the last 30 days whose branch starts with `branchPrefix`, with the head pipeline of open ones and Renovate's branch result (`renovateMergeRequests`).

A run that writes no report, exits non-zero or logs a fatal problem is a `failed` result with the log tail, not a failed job. The token is masked in the stored log.

Mise's `npm:` backend is not used on purpose: its trust policy rejects `@yarnpkg/libzip@3.2.2`, a transitive dependency of this Renovate release that lost the provenance attestation earlier versions had.

## Options

The `analyzers.renovate` setting, edited in the panel with a dedicated form (`editor: 'renovate'`) that explains what the current values make Renovate do.

| Option                | Default                          | Meaning                                                                                      |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `mode`                | `report`                         | `report`: look up and report only. `merge-requests`: Renovate opens its merge requests       |
| `updates`             | `all`                            | `security`: only updates that fix a known vulnerability                                      |
| `majors`              | `true`                           | Propose major updates                                                                        |
| `grouping`            | `separate`                       | `separate` (monorepo packages together), `non-major` (`group:allNonMajor`), `all`            |
| `releaseAgeDays`      | `3`                              | Renovate's `minimumReleaseAge`; `0` proposes releases at once                                |
| `vulnerabilityAlerts` | `true`                           | Advisories from OSV (`osvVulnerabilityAlerts`); fixes skip the release age                   |
| `lockFileMaintenance` | `false`                          | Refresh every lockfile weekly                                                                |
| `rangeStrategy`       | `auto`                           | `auto`, `bump`, `replace`, `widen`, `pin`, `update-lockfile`                                 |
| `ignore`              | `[]`                             | Package names or globs never updated                                                         |
| `concurrentLimit`     | `10`                             | `prConcurrentLimit`; `0` is unlimited                                                        |
| `hourlyLimit`         | `2`                              | `prHourlyLimit`; `0` is unlimited                                                            |
| `draft`               | `false`                          | Open merge requests as drafts                                                                |
| `labels`              | `['holtkeeper', 'dependencies']` |                                                                                              |
| `branchPrefix`        | `renovate/`                      | Renovate owns branches with this prefix; merge requests are matched by it                    |
| `dependencyDashboard` | `false`                          | Keep Renovate's dashboard issue                                                              |
| `repoConfig`          | `merge`                          | `merge`: a repository's `renovate.json` applies on top (`requireConfig: optional`); `ignore` |
| `presets`             | `['config:recommended']`         | Renovate presets every repository extends                                                    |
| `config`              | `{}`                             | Raw Renovate repository options merged last; its `packageRules` follow the generated ones    |
| `timeoutMinutes`      | `30`                             | One run                                                                                      |

Presets (`renovatePresets`): **Report only**, **Calm** (minor and patch together, 7 days of release age, 5 open, weekly lockfile maintenance), **Stay current** (one per dependency, 1 day, 20 open), **Security fixes only**.

As with every analyzer setting, the most specific entry covering a repository wins as a whole: a group entry that switches to `merge-requests` keeps the defaults for everything it does not set.

## Data and report

`RenovateData` (`renovateDataSchema`): `status` (`ok`, `failed`), the `mode` the run used, `readOnly`, `renovateVersion`, `startedAt`, `durationMs`, `dependencies` and `outdated` counts, `libYears`, `managers`, `updates` (`dependency`, `manager`, `file`, `current`, `next`, `type`, `vulnerability`, `pending`, `releasedAt`, `url`, `mergeRequest`), `deprecated`, `mergeRequests` (`id`, `url`, `title`, `branch`, `state`, `draft`, `pipeline`, `result`, `types`, `updates`, `mergedAt`), `problems`, `output` and `apiRequests`. `isBroken` (open with a failed pipeline or a Renovate error) and `awaitsReview` classify merge requests; `mergeRequestStatus` names them.

`renovateAnalysis` renders the metrics outdated, major updates, security fixes, open and broken merge requests, libyears and API requests, with deltas against the previous run, and the sections **Available updates** (by type, then a table with versions, notes, release date and merge request), **Merge requests** (broken first) and **Dependency health** (deprecated and abandoned packages, Renovate's problems, what each manager found).

## Requirements and limits

- The worker needs `mise` and network access to the npm registry (Renovate and Node are fetched on the first run and cached) and to the forge API; package registries Renovate looks up go through the worker's network, not the job sandbox.
- With `binarySource: global`, lockfile updates in `merge-requests` mode use the package managers on the worker's `PATH` (npm comes with Node); add pnpm, yarn or Go to the worker image for repositories that use them.
- Git (clone, push) and lookups Renovate makes on the forge host outside its API endpoint (a GitLab package registry in `.npmrc`, `gitlab-tags`) go to the forge directly, not through the rate limiter.
- GitLab and GitHub forges only.
