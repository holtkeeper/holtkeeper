# Holtkeeper — plan

Holtkeeper is an automation engine for a fleet of Git repositories (GitLab and GitHub): code review, dependency updates, vulnerability audits, releases. It is driven through a CLI, a web interface and a chat bot.

This repository holds the public engine and generic plugins. The concrete setup (repository list, tokens, rules, custom plugins) lives in a separate private repository that depends on the `@holtkeeper/*` packages and describes everything in `holtkeeper.config.ts`.

## Principles

- **Everything behind interfaces.** Git hosting, LLM, chat, storage and command execution are adapters behind abstractions. A new provider is a new adapter package; the core does not change.
- **Plugins, not features.** Every automation is a plugin with one contract (triggers, config schema, handler). Built-in plugins are no different from those written in the private repository.
- **Config as code.** `defineConfig()` with full typing, presets and `extends` (like Renovate), repository groups and overrides per group or repository.
- **CLI first.** Any task runs with a single command (`holtkeeper run audit --repo games/*`) — locally, from cron or from a scheduled pipeline. The server, webhooks, UI and bot are built on top of the same core.
- **Safe by default.** `dryRun` mode, every change goes through an MR rather than a direct push, dangerous actions (release, deploy) require human confirmation.
- **No build step.** Libraries export TypeScript source and Bun runs it directly; see [development.md](development.md#no-build-step).
- **Reuse, don't rewrite.** Renovate for dependency updates, Chat SDK for bots, Claude Agent SDK for agentic tasks, gitbeaker/octokit for APIs.

## Stack

| Area                                     | Choice                                                                                                                                             | Why                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Runtime, package manager, tests, bundler | **Bun 1.4**                                                                                                                                        | One tool instead of node+pnpm+vitest+tsup, runs TypeScript without a build, built-in workspaces, `bun:sqlite`, `Bun.$` for shell |
| Type checking                            | **TypeScript 7** (tsgo, the native Go compiler)                                                                                                    | Stable since 7.0, much faster type checking; used only as a checker (`tsc --noEmit`), Bun runs the code                          |
| Linter                                   | **oxlint** (+ type-aware rules via tsgolint)                                                                                                       | Fastest option, compatible with ESLint/typescript-eslint rules, runs on the same tsgo                                            |
| Formatter                                | **oxfmt**                                                                                                                                          | Prettier-compatible output, an order of magnitude faster; same Oxc ecosystem                                                     |
| Dead code                                | **knip**                                                                                                                                           | Unused files, exports and dependencies across the monorepo                                                                       |
| Git hooks                                | **lefthook**                                                                                                                                       | Single binary, parallel execution                                                                                                |
| Validation, config schema                | **zod 4**                                                                                                                                          | Types from schemas, `toJSONSchema()` for config autocompletion and UI forms                                                      |
| HTTP server, API                         | **Hono**                                                                                                                                           | Runs on `Bun.serve`, typed RPC client for the web app, webhook middleware                                                        |
| Database                                 | **SQLite (`bun:sqlite`)** behind the `Store` contract                                                                                              | Zero infrastructure; another database is another `Store` implementation passing the shared contract tests                        |
| Job queue                                | Custom, on top of the same database                                                                                                                | Retries, per-repository concurrency, run history; no Redis to start                                                              |
| Web                                      | **Vite 8 + React 19 + TanStack Router/Query**                                                                                                      | Fast builds, typed routing, Hono RPC as the client                                                                               |
| UI kit                                   | **HeroUI 3** (React Aria + Tailwind CSS 4), **Motion** for page and list transitions, **Recharts** for charts, **TanStack Table** for large tables | Polished, animated components out of the box with strong accessibility; Motion covers transitions HeroUI's CSS animations do not |
| Chat bot                                 | **Chat SDK** (`chat` + `@chat-adapter/slack`)                                                                                                      | Already an abstraction over Slack/Teams/Discord/Google Chat with cards, buttons and slash commands                               |
| GitLab / GitHub API                      | **@gitbeaker/rest**, **@octokit/rest**                                                                                                             | Complete typed clients                                                                                                           |
| AI agent                                 | **Claude Agent SDK**                                                                                                                               | An agent with access to a repository checkout: reads code, runs commands, edits files                                            |
| Vulnerability scanning                   | **OSV-Scanner** (binary)                                                                                                                           | Lockfile-based, many ecosystems, OSV ids                                                                                         |
| Dependency updates                       | **Renovate** (as a CLI)                                                                                                                            | No reinventing package managers, changelogs, grouping and schedules                                                              |
| CI for this repository                   | GitHub Actions                                                                                                                                     | lint → typecheck → test → knip                                                                                                   |

Turborepo is not needed yet: `bun run --filter` is enough. Revisit if builds get slow.

## Monorepo layout

- `apps/` — `cli`, `server`, `web`
- `packages/` — contracts (`core`, `forge`, `exec`, `store`, `access`, `auth`, `report`, `changes`, `analyzer`, `vuln`, `quality`, `agent`) and their replaceable implementations
- `plugins/` — automations on the plugin contract
- `fixtures/` — vulnerable sample projects for tests
- `examples/dev/` — local development config and demo data

The full module list with links is in [docs/README.md](README.md). Every module has its own `docs/` folder.

## Core abstractions

### GitForge

A single interface over GitLab and GitHub. It covers what plugins need, not the whole API:

- repositories: listing by group/organization, reading files, default branch;
- branches, commits (including multi-file commits through the API without cloning);
- MRs/PRs: create, update, find an existing one by branch, labels, reviewers, merge, auto-merge;
- diffs and line comment threads, **suggestions** (GitLab ` ```suggestion:-0+0 `, GitHub ` ```suggestion `), resolving threads;
- pipelines and jobs: status, running manual jobs (`play`), retry, waiting for completion;
- tags and releases;
- webhooks: signature verification and normalization into shared event types (`mr.opened`, `mr.updated`, `mr.comment`, `pipeline.finished`, `tag.pushed`…).

Terminology differences (MR/PR, group/org, pipeline/workflow) are hidden inside adapters. Provider-specific features are exposed through `capabilities` and an explicit escape hatch to the native client.

### Plugin

```ts
export default definePlugin({
  name: 'browserslist',
  config: z.object({ schedule: z.string().default('0 6 * * 1') }),
  triggers: [schedule(), command('update-browserslist')],
  async run(ctx) {
    // ctx.repo, ctx.forge, ctx.workspace, ctx.agent, ctx.chat, ctx.config, ctx.log
  },
})
```

Triggers: schedule, webhook event, MR comment command (`/holtkeeper review`), chat bot command, UI button, manual CLI run. The outcome of every run (created MRs, comments, errors) is stored and visible in the UI.

### Config

```ts
export default defineConfig({
  forges: { work: gitlab({ url: 'https://gitlab.example.com', token: env('GITLAB_TOKEN') }) },
  groups: {
    games: { forge: 'work', match: ['games/*'], exclude: ['games/legacy-*'] },
  },
  plugins: {
    browserslist: { groups: ['games'] },
    audit: { groups: ['games'], allowlist: [/* ... */] },
  },
  repos: {
    'games/app-x': { audit: { ssr: true } },
  },
})
```

The public repository ships presets (`extends: ['holtkeeper:recommended']`); the private one holds the real values and its own plugins.

### Workspace

Cloning into a temporary directory (shallow, cached), detecting the package manager from the lockfile (bun/pnpm/npm/yarn), running commands, collecting the diff, committing and pushing to a branch. The executor sits behind an interface: a local process for now, a Docker container or a CI job later — so third-party `postinstall` scripts and the agent do not run on the server host.

### Agent

An interface of "give the agent a checkout, a task and tools, get back changes or a report". The default adapter is Claude Agent SDK, with a configurable model. Used by review, deps (refactoring for breaking changes) and audit (classifying whether a vulnerability applies).

## Plugins

### 1. Code review

- Triggers: MR opened/updated, `/holtkeeper review` command.
- Context: the diff, full content of touched files, project rules (`REVIEW.md`, `CLAUDE.md`, `AGENTS.md` from the repository + rules from the config).
- Output: line threads with suggestions, a summary comment, optional approve/request changes.
- On re-push: incremental review of the new diff only, no duplicates; the bot resolves its own threads once the issue is fixed.
- Replies to bot threads continue the conversation in the thread.
- Settings: ignored paths, diff size limit, strictness, draft vs ready MRs.

### 2. Browserslist

Status: done as the `browserslist` analyzer ([packages/browserslist](../packages/browserslist/docs/README.md)) on a default weekly schedule; it runs only in repositories whose lockfile resolves `caniuse-lite` (analyzer `appliesTo`). Auto-merge waits for the forge contract.

- On a schedule per repository group: `update-browserslist-db` through the repository's package manager.
- If the lockfile changed — branch, commit, MR (or update the already open MR), optional auto-merge after a green pipeline.
- Report: whether the resolved browser list changed (`browserslist` before/after) — the main thing a reviewer looks at.
- First plugin to implement: exercises the whole clone → command → commit → MR path without AI.

### 3. Package update propagation

Status: our own packages roll out through [packages/propagate](../packages/propagate/docs/README.md) (own bump, checks and agent fixes before the MR opens); third-party updates run on Renovate inside Holtkeeper ([packages/renovate](../packages/renovate/docs/README.md)), report-only by default; the summary across repositories is the **Dependency updates** page. Renovate's forge API calls go through the per-token limiter via a loopback proxy. Not done: the agent fixing failed Renovate MRs.

- Sources: releases in our own monorepos/package repositories (webhook on a tag or registry publish) and third-party packages.
- The update mechanics for third-party packages are Renovate: holtkeeper generates its config from the `analyzers.renovate` setting (which repositories, grouping, release age, limits) and runs the CLI per repository.
- Holtkeeper on top: watches the pipeline of Renovate MRs; if typecheck/tests/build fail, the agent gets the package changelog and migration guide, fixes the code in the same branch and pushes. If it fails, it posts a comment with an analysis and mentions the owner.
- Summary across all repositories: what is updated, what awaits review, what is broken.

### 4. Vulnerability audit

Status: scanner, fixers, allowlist and `holtkeeper audit` exist (see [packages/vuln](../packages/vuln/docs/README.md)); the plugin that opens MRs comes with the workspace and forge adapters.

- One contract for every language: a `Scanner` produces `Finding`s, a chain of `Fixer`s changes the project, a rescan decides what was resolved. Ecosystems are added as fixer packages without touching the rest.
- Scanning: **OSV-Scanner** reads lockfiles of any supported ecosystem (JS, Go, Python, Java, PHP, Rust, Ruby…) without installing dependencies.
- Fixing: `osv-scanner fix` first where it works (npm `package-lock.json`, Maven `pom.xml`), then ecosystem fixers for the rest: JavaScript (bun, pnpm, yarn, npm leftovers — ranges and overrides), Go (`go get`). Next candidates: Python (uv, pip-tools, poetry), Rust, PHP.
- Allowlist: entries with a reason, author, expiry date, package, path globs and trait conditions (`when: { ssr: false }`), applied by Holtkeeper after scanning so it is scanner-independent. Expired entries surface again. The agent will later propose entries for a human to confirm.
- Optional sources later: Trivy for containers and IaC, Dependabot alerts when the forge is GitHub.

### 5. Releases

- Creating a `develop → main` MR with a changelog from commits/MRs, readiness checks (green pipeline, no open blockers).
- After merge: a tag following the project scheme (semver/calver/custom), a release with notes.
- Deploy: running the pipeline's manual jobs for the tag, waiting, retries, status notifications.
- Everything is described as steps in the config (projects have different flows), with human confirmation on dangerous steps — a Slack or UI button.
- Batch mode: "release all games in group X" with one command.

## Analyses

Every analysis produces its own data and renders it into the universal report format of [`@holtkeeper/report`](../packages/report/docs/README.md), so one UI shows all of them and compares any two runs (by default the previous release):

- **Changelog** — commits between releases or tags, grouped by type and scope, identical messages collapsed, links to commits, merge requests and tickets.
- **Bundle size** — per entrypoint and per package (source maps), raw/gzip/brotli, growth between releases. Any bundler.
- **Dependencies** — workspace graph, package graph from lockfiles, module imports; cycles and libraries in several versions. JS and Go sources; more are new `GraphSource`s.
- **Package usage** — which exports, members and JSX props of each dependency a repository uses and where, through imports and the TypeScript 7 checker; joined across repositories into "used by" and the uses an upgrade breaks, for people and for agents over MCP.
- **Code quality** — naming conventions inferred from the project (ast-grep), test gaps from coverage with example tests written by the agent in the project's style, linters through SARIF (oxlint, ESLint, Biome, golangci-lint, ruff, Semgrep, ast-grep), duplication (jscpd).

Suggested code changes from any analysis share one shape ([`@holtkeeper/changes`](../packages/changes/docs/README.md)) and can be accepted from a report as a patch or a merge request.

Ideas next: a task engine (queue, scheduler, workspace clones) so analyses run on every tag and on a schedule; fleet drift (library versions and shared configs across repositories); release risk; DORA and CI health; secret and license scanning; asset budgets; i18n gaps; dead code (knip); Sentry errors per release.

## Interfaces

- **CLI** — the first interface: `run <plugin>`, `--repo`/`--group`, `--dry-run`, `validate-config`, `explain`, `audit`, `serve`.
- **Server** — webhook intake, scheduler, queue, API for the web app and bot. _Started: API for audits, repositories, credentials, settings and activity; audit ingestion; credential rotation._
- **Web** — repositories and their state per plugin, run history with logs, manual runs, confirmations, audit allowlist, release dashboard. _Started: dashboard, audit reports, repositories, credentials, settings, users, activity._
- **Chat bot** — notifications, confirmation buttons (release, allowlist), commands (`/holtkeeper release games/app-x`), replies in threads. Slack first, the rest through Chat SDK adapters.

### Access

Sign-in is a replaceable `AuthProvider`; permissions are the same everywhere:

1. `noAuth()` — no sign-in, one root user.
2. `headerAuth()` — users and grants from a reverse proxy's headers.
3. `passwordAuth()` — root behind a password.
4. `usersAuth()` — real users with passkeys only (setup and recovery through one-time links) or OIDC, with scoped grants: e.g. admins of `games/**` who can invite people only within that scope.

Credentials (forge accounts, API keys) and settings (models, keys, review rules, audit policy) are scoped to everything, groups or repository patterns; the most specific setting wins. GitLab tokens rotate automatically before they expire.

## Milestones

**0. Foundation**

- Bun workspaces monorepo, TS 7, oxlint + oxfmt, knip, lefthook, CI.
- `core`: config schema, `defineConfig`, plugin contract, config loading.
- `forge` + `forge-gitlab` (primary), `forge-github` skeleton, contract tests.
- `workspace`, `apps/cli`.

**1. Browserslist** — the first end-to-end scenario without AI. _Done._

**2. Audit** — without the agent: report normalization, autofix, allowlist. _Engine and CLI done; MR plugin pending the workspace._

**3. Releases via CLI** — develop → main MR, tags, running jobs.

**4. Server** — `storage`, queue, scheduler, webhooks; moving plugins to server-side triggers.

**5. Agent and code review** — `agent` package, `review` plugin, comment commands.

**6. Update propagation** — Renovate integration, AI fixing of failed MRs; agent classification in audit.

**7. Chat bot** — Slack notifications and confirmations.

**8. Web interface.**

**9. GitHub** — bringing the adapter to parity, running the contract tests.

After milestone 0 every next milestone is immediately useful at work: plug it into the private config and use it.

## Open questions

- Publishing `@holtkeeper/*` packages: packages ship TypeScript source; still open is npm (changesets) vs the private repository pulling them from git.
- Where the server is hosted and where tasks run: a dedicated machine/container or GitLab CI runners (then the CLI mode stays primary for a long time).
- Authentication: a bot account with a PAT, a GitLab group access token or an OAuth app (GitHub App) — this determines permissions and API limits.
- Web interface access: is SSO via GitLab OAuth enough?

## Decisions

- Web UI kit: HeroUI 3. App code uses it through our own thin components where a swap would otherwise touch many screens (tables, forms, layout).

- License: MIT.
- No build step for libraries; consumers run Bun.
- Agent instructions live in `AGENTS.md`; `CLAUDE.md` imports it.
