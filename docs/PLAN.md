# Holtkeeper — plan

Holtkeeper is an automation engine for a fleet of Git repositories (GitLab and GitHub): code review, dependency updates, vulnerability audits, releases. People drive it through the web panel; AI agents through its MCP endpoint.

This repository holds the public engine and its analyzers. The infrastructure (storage, secrets, sign-in, workers) lives in `holtkeeper.config.ts`, often in a separate private repository that depends on the `@holtkeeper/*` packages; forges, repository groups, schedules, triggers, rules and analyzer options are managed in the panel.

## Principles

- **Everything behind interfaces.** Git hosting, LLM, chat, storage and command execution are adapters behind abstractions. A new provider is a new adapter package; the core does not change.
- **Analyzers, not features.** Every automation is an analyzer with one contract (options schema, scope, what it needs, run); webhooks, schedules, comment commands and the panel all queue the same analyzers.
- **Config as code for infrastructure.** `defineConfig()` with full typing holds what a deployment needs (server, job execution, limits, AI providers); groups, repository traits, forges and automation live in the panel.
- **Panel first.** Work runs on the server — on webhooks, schedules or a button in the panel. Agents get the same data and actions over MCP.
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
- `fixtures/` — vulnerable sample projects for tests
- `examples/dev/` — local development config and demo data

The full module list with links is in [docs/README.md](README.md). Every module has its own `docs/` folder.

## Core abstractions

### GitForge

A single interface over GitLab and GitHub. It covers what analyzers need, not the whole API:

- repositories: listing by group/organization, reading files, default branch;
- branches, commits (including multi-file commits through the API without cloning);
- MRs/PRs: create, update, find an existing one by branch, labels, reviewers, merge, auto-merge;
- diffs and line comment threads, **suggestions** (GitLab ` ```suggestion:-0+0 `, GitHub ` ```suggestion `), resolving threads;
- pipelines and jobs: status, running manual jobs (`play`), retry, waiting for completion;
- tags and releases;
- webhooks: signature verification and normalization into shared event types (`mr.opened`, `mr.updated`, `mr.comment`, `pipeline.finished`, `tag.pushed`…).

Terminology differences (MR/PR, group/org, pipeline/workflow) are hidden inside adapters. Provider-specific features are exposed through `capabilities` and an explicit escape hatch to the native client.

### Analyzer

The contract lives in [@holtkeeper/analyzer](../packages/analyzer/docs/README.md): a `kind`, an options schema, a `scope` (one repository or a whole group), what the run `needs` (checkout, forge, agent, history) and `run`. Triggers: schedule, webhook event, MR comment command (`/holtkeeper review`), chat command, a button in the panel. The outcome of every run (created MRs, comments, errors) is stored and visible in the UI.

### Config

`holtkeeper.config.ts` holds infrastructure only: store, artifacts, sign-in, vault key, listener, worker execution and egress, shared limits and AI provider plugins.

```ts
export default defineConfig({
  server: {
    auth: passwordAuth({ password: env('HOLTKEEPER_PASSWORD'), sessionSecret: env('SESSION') }),
    store: postgresStore({ url: env('DATABASE_URL') }),
    vaultKey: env('HOLTKEEPER_VAULT_KEY'),
  },
  jobs: { execution: { mode: 'mise' }, concurrency: 2 },
  limits: { distributed: true },
})
```

Forges, groups, repository traits, schedules, triggers, policies, analyzer options and budgets live in the database and are edited in the panel, which seeds sensible defaults on first start. Keys the file no longer takes are warned about and ignored.

### Workspace

Cloning into a temporary directory (shallow, cached), detecting the package manager from the lockfile (bun/pnpm/npm/yarn), running commands, collecting the diff, committing and pushing to a branch. The executor sits behind an interface: a local process for now, a Docker container or a CI job later — so third-party `postinstall` scripts and the agent do not run on the server host.

### Agent

An interface of "give the agent a checkout, a task and tools, get back changes or a report". The default adapter is Claude Agent SDK, with a configurable model. Used by review, deps (refactoring for breaking changes) and audit (classifying whether a vulnerability applies).

## Automations

### 1. Code review

- Triggers: MR opened/updated, `/holtkeeper review` command.
- Context: the diff, full content of touched files, project rules (`REVIEW.md`, `CLAUDE.md`, `AGENTS.md` from the repository + rules from the config).
- Output: line threads with suggestions, a summary comment, optional approve/request changes.
- On re-push: incremental review of the new diff only, no duplicates; the bot resolves its own threads once the issue is fixed.
- Replies to bot threads continue the conversation in the thread.
- Settings: ignored paths, diff size limit, strictness, draft vs ready MRs.

### 2. Browserslist

Status: done as the `browserslist` analyzer ([packages/browserslist](../packages/browserslist/docs/README.md)) refreshed weekly by freshness; it runs only in repositories whose lockfile resolves `caniuse-lite` (analyzer `appliesTo`). Auto-merge waits for the forge contract.

- On a schedule per repository group: `update-browserslist-db` through the repository's package manager.
- If the lockfile changed — branch, commit, MR (or update the already open MR), optional auto-merge after a green pipeline.
- Report: whether the resolved browser list changed (`browserslist` before/after) — the main thing a reviewer looks at.
- First automation to implement: exercises the whole clone → command → commit → MR path without AI.

### 3. Package update propagation

Status: our own packages roll out through [packages/propagate](../packages/propagate/docs/README.md) (own bump and checks; repositories whose checks fail get a proposed `propagate-fix` write task that carries the bump); third-party updates run on Renovate inside Holtkeeper ([packages/renovate](../packages/renovate/docs/README.md)), report-only by default; Renovate state per library shows on the **Dependencies** page. Renovate's forge API calls go through the per-token limiter via a loopback proxy. Not done: the agent fixing failed Renovate MRs.

- Sources: releases in our own monorepos/package repositories (webhook on a tag or registry publish) and third-party packages.
- The update mechanics for third-party packages are Renovate: holtkeeper generates its config from the `analyzers.renovate` setting (which repositories, grouping, release age, limits) and runs the CLI per repository.
- Holtkeeper on top: watches the pipeline of Renovate MRs; if typecheck/tests/build fail, the agent gets the package changelog and migration guide, fixes the code in the same branch and pushes. If it fails, it posts a comment with an analysis and mentions the owner.
- Summary across all repositories: what is updated, what awaits review, what is broken.

### 4. Vulnerability audit

Status: scanner, fixers and allowlist run as the server's `audit` analyzer (see [packages/vuln](../packages/vuln/docs/README.md)); opening MRs with the fixes comes with the workspace and forge adapters.

- One contract for every language: a `Scanner` produces `Finding`s, a chain of `Fixer`s changes the project, a rescan decides what was resolved. Ecosystems are added as fixer packages without touching the rest.
- Scanning: **OSV-Scanner** reads lockfiles of any supported ecosystem (JS, Go, Python, Java, PHP, Rust, Ruby…) without installing dependencies.
- Fixing: `osv-scanner fix` first where it works (npm `package-lock.json`, Maven `pom.xml`), then ecosystem fixers for the rest: JavaScript (bun, pnpm, yarn, npm leftovers — ranges and overrides), Go (`go get`). Next candidates: Python (uv, pip-tools, poetry), Rust, PHP.
- Allowlist: entries with a reason, author, expiry date, package, path globs and trait conditions (`when: { ssr: false }`), applied by Holtkeeper after scanning so it is scanner-independent. Expired entries surface again. The agent will later propose entries for a human to confirm.
- Optional sources later: Trivy for containers and IaC, Dependabot alerts when the forge is GitHub.

### 5. Releases

Status: the release assistant ([packages/release](../packages/release/docs/README.md)) proposes the next version from conventional commits, builds the changelog of unique messages and a summary, opens or updates the `develop → main` candidate merge request, creates versions after a configurable acceptance (person, API, label or merge), deploys through the tag pipeline's manual jobs and follows them; the **Releases** pages in the web UI (overview cards, a version timeline per repository, the flow diagram). Chat: `/holtkeeper release` in merge requests shows the state and runs the steps with confirmations, and a deploy card is edited in place as the deploy runs. The panel has its own **Chat** page.

- Creating a `develop → main` MR with a changelog from commits/MRs, readiness checks (green pipeline, no open blockers).
- After merge: a tag following the project scheme (semver or calendar versions), a release with notes.
- Deploy: running the pipeline's manual jobs for the tag, waiting, retries, status notifications.
- Flows are fixed modes (merge request, trunk, external) set per repository in a few settings; a person confirms every step that writes to a forge, in the panel, in chat or over MCP with a confirm token. Repositories are released one at a time; there is no batch mode.

## Analyses

Every analysis produces its own data and renders it into the universal report format of [`@holtkeeper/report`](../packages/report/docs/README.md), so one UI shows all of them and compares any two runs (by default the previous release):

- **Changelog** — commits between releases or tags, grouped by type and scope, identical messages collapsed, links to commits, merge requests and tickets.
- **Bundle size** — app builds (one or many targets, each with its entrypoints) and published packages (archives from their registry), per entrypoint and per package (source maps), raw/gzip/brotli, history across releases and versions. Any bundler.
- **Dependencies** — workspace graph, package graph from lockfiles, module imports; cycles and libraries in several versions. JS and Go sources; more are new `GraphSource`s.
- **Package usage** — which exports, members and JSX props of each dependency a repository uses and where, through imports and the TypeScript 7 checker; joined across repositories into "used by" and the uses an upgrade breaks, for people and for agents over MCP.
- **Test coverage** — line, function and branch coverage per file from the project's own test runner; test attributes frontend templates expose.

Suggested code changes from any analysis share one shape ([`@holtkeeper/changes`](../packages/changes/docs/README.md)) and can be accepted from a report as a patch or a merge request.

Ideas next: a task engine (queue, scheduler, workspace clones) so analyses run on every tag and on a schedule; fleet drift (library versions and shared configs across repositories); CI health; secret and license scanning; asset budgets; i18n gaps; team rules checked on every merge request; Sentry errors per release.

## Interfaces

- **Web panel** — the primary interface for people. _Started: Home, audit reports, repositories, credentials, settings, users, history, automation, releases._
- **MCP** — the interface for AI agents: package APIs, usages, library docs, knowledge, commit conventions (`POST /mcp`, see [apps/server](../apps/server/docs/README.md)).
- **CLI** — only the server's entrypoint: `holtkeeper serve` (the Helm chart's command) and `holtkeeper users` for operator account tasks such as an agent's login link ([agent-access.md](agent-access.md)).
- **Server** — webhook intake, scheduler, queue, API for the web app and bot. _Started: API for audits, repositories, credentials, settings and history; audit ingestion; credential rotation._
- **Chat bot** — notifications, confirmation buttons (release, allowlist), commands (`/holtkeeper release games/app-x`), replies in threads. Slack first, the rest through Chat SDK adapters. _Started: [@holtkeeper/chat](../packages/chat/docs/README.md) with commands, cards, forms and the merge request surface; `release`, `verify` and `jobs.commands` run through it; the Slack integration was removed for now and will come back differently: only its stored app tokens and the Block Kit rendering in [@holtkeeper/chat-slack](../packages/chat-slack/docs/README.md) remain._
- **Digests** — scheduled summaries of what analyses found (license problems, images to optimize, stale merge requests…) per group of repositories, to Slack channels and panel chats. _A first version was removed together with the Slack integration; not started again yet._

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
- `core`: config schema, `defineConfig`, config loading.
- `forge` + `forge-gitlab` (primary), `forge-github` skeleton, contract tests.
- `workspace`, `apps/cli`.

**1. Browserslist** — the first end-to-end scenario without AI. _Done._

**2. Audit** — without the agent: report normalization, autofix, allowlist. _Engine done; fix MRs pending the workspace._

**3. Releases via CLI** — develop → main MR, tags, running jobs.

**4. Server** — `storage`, queue, scheduler, webhooks; moving automations to server-side triggers.

**5. Agent and code review** — `agent` package, `review` analyzer, comment commands.

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
