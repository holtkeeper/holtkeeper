# Documentation

## Project

- [Plan](PLAN.md) — goals, architecture and milestones
- [Development](development.md) — tooling, conventions, why there is no build step
- [Deployment](deployment.md) — Docker, compose, Kubernetes (Helm), roles, scaling, backups
- [Agent access](agent-access.md) — let an AI agent sign in to the web UI with its own account and a login link
- [Library docs for agents](libraries.md) — set up and use version-exact docs, API and issues of third-party libraries over MCP ([design](library-docs.md))

## Modules

| Module                            | Role                                                                          | Docs                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@holtkeeper/cli`                 | `holtkeeper` command: `serve` and `users`                                     | [apps/cli/docs](../apps/cli/docs/README.md)                                         |
| `@holtkeeper/server`              | HTTP API, auth endpoints, jobs, web UI hosting                                | [apps/server/docs](../apps/server/docs/README.md)                                   |
| `@holtkeeper/web`                 | Admin panel (Graphite design)                                                 | [apps/web/docs](../apps/web/docs/README.md)                                         |
| `@holtkeeper/core`                | Config schema and loading, repository resolution                              | [packages/core/docs](../packages/core/docs/README.md)                               |
| `@holtkeeper/api`                 | HTTP contract shared by server and clients                                    | [packages/api/docs](../packages/api/docs/README.md)                                 |
| `@holtkeeper/web-paths`           | Paths of the panel's pages for links from server and packages                 | [packages/web-paths/docs](../packages/web-paths/docs/README.md)                     |
| `@holtkeeper/access`              | Grants, scopes, permission checks, delegation                                 | [packages/access/docs](../packages/access/docs/README.md)                           |
| `@holtkeeper/auth`                | Auth provider contract, sessions                                              | [packages/auth/docs](../packages/auth/docs/README.md)                               |
| `@holtkeeper/auth-none`           | No sign-in, single root user                                                  | [packages/auth-none/docs](../packages/auth-none/docs/README.md)                     |
| `@holtkeeper/auth-header`         | Users and grants from proxy headers                                           | [packages/auth-header/docs](../packages/auth-header/docs/README.md)                 |
| `@holtkeeper/brand`               | The mascot (SVG) for the web UI and docs site                                 | [packages/brand/docs](../packages/brand/docs/README.md)                             |
| `@holtkeeper/auth-password`       | Root behind a password                                                        | [packages/auth-password/docs](../packages/auth-password/docs/README.md)             |
| `@holtkeeper/auth-users`          | Users with passkeys and OIDC, invites, recovery                               | [packages/auth-users/docs](../packages/auth-users/docs/README.md)                   |
| `@holtkeeper/identities`          | External accounts linked to principals, challenges, external actors           | [packages/identities/docs](../packages/identities/docs/README.md)                   |
| `@holtkeeper/store`               | Persistence contract, memory store, contract tests                            | [packages/store/docs](../packages/store/docs/README.md)                             |
| `@holtkeeper/store-sqlite`        | SQLite store                                                                  | [packages/store-sqlite/docs](../packages/store-sqlite/docs/README.md)               |
| `@holtkeeper/store-postgres`      | PostgreSQL store                                                              | [packages/store-postgres/docs](../packages/store-postgres/docs/README.md)           |
| `@holtkeeper/vault`               | Encryption of secrets at rest                                                 | [packages/vault/docs](../packages/vault/docs/README.md)                             |
| `@holtkeeper/settings`            | Scoped settings and their resolution                                          | [packages/settings/docs](../packages/settings/docs/README.md)                       |
| `@holtkeeper/credentials`         | Credential service, rotation scheduling                                       | [packages/credentials/docs](../packages/credentials/docs/README.md)                 |
| `@holtkeeper/forge`               | Git hosting contract                                                          | [packages/forge/docs](../packages/forge/docs/README.md)                             |
| `@holtkeeper/forge-gitlab`        | GitLab adapter and token rotation                                             | [packages/forge-gitlab/docs](../packages/forge-gitlab/docs/README.md)               |
| `@holtkeeper/exec`                | Command execution contract                                                    | [packages/exec/docs](../packages/exec/docs/README.md)                               |
| `@holtkeeper/workspace`           | Repository checkouts with a mirror cache                                      | [packages/workspace/docs](../packages/workspace/docs/README.md)                     |
| `@holtkeeper/jobs`                | Task engine: queue, scheduler, worker                                         | [packages/jobs/docs](../packages/jobs/docs/README.md)                               |
| `@holtkeeper/updates`             | Polling forges for changes within a per-token budget                          | [packages/updates/docs](../packages/updates/docs/README.md)                         |
| `@holtkeeper/managed-config`      | Panel-managed forges, groups, schedules and triggers; the effective config    | [packages/managed-config/docs](../packages/managed-config/docs/README.md)           |
| `@holtkeeper/agent`               | LLM agent contract and Claude adapter                                         | [packages/agent/docs](../packages/agent/docs/README.md)                             |
| `@holtkeeper/ai-usage`            | AI usage recording, costs and budgets                                         | [packages/ai-usage/docs](../packages/ai-usage/docs/README.md)                       |
| `@holtkeeper/ai-waibee`           | Waibee Router as an AI provider plugin                                        | [packages/ai-waibee/docs](../packages/ai-waibee/docs/README.md)                     |
| `@holtkeeper/chat`                | Chat commands, cards and surfaces: merge request notes and the panel          | [packages/chat/docs](../packages/chat/docs/README.md)                               |
| `@holtkeeper/chat-slack`          | Block Kit rendering of chat cards and forms                                   | [packages/chat-slack/docs](../packages/chat-slack/docs/README.md)                   |
| `@holtkeeper/notify`              | Notifications: webhooks, Slack text                                           | [packages/notify/docs](../packages/notify/docs/README.md)                           |
| `@holtkeeper/report`              | Universal report format and analysis kinds                                    | [packages/report/docs](../packages/report/docs/README.md)                           |
| `@holtkeeper/artifacts`           | Content-addressed blob store (fs, memory, S3), ZIP, storage providers         | [packages/artifacts/docs](../packages/artifacts/docs/README.md)                     |
| `@holtkeeper/changes`             | Suggested code changes: apply, diff, patch, merge request                     | [packages/changes/docs](../packages/changes/docs/README.md)                         |
| `@holtkeeper/analyzer`            | Analyzer contract the task engine runs                                        | [packages/analyzer/docs](../packages/analyzer/docs/README.md)                       |
| `@holtkeeper/analyzers`           | Registry of built-in analyzers                                                | [packages/analyzers/docs](../packages/analyzers/docs/README.md)                     |
| `@holtkeeper/vuln`                | Vulnerability audit contracts, allowlist, orchestration                       | [packages/vuln/docs](../packages/vuln/docs/README.md)                               |
| `@holtkeeper/vuln-osv`            | OSV-Scanner scanner and fixer                                                 | [packages/vuln-osv/docs](../packages/vuln-osv/docs/README.md)                       |
| `@holtkeeper/vuln-js`             | npm/bun/pnpm/yarn fixer                                                       | [packages/vuln-js/docs](../packages/vuln-js/docs/README.md)                         |
| `@holtkeeper/vuln-go`             | Go modules fixer                                                              | [packages/vuln-go/docs](../packages/vuln-go/docs/README.md)                         |
| `@holtkeeper/commit-conventions`  | Commit and branch naming rules from settings, push rules, commitlint, history | [packages/commit-conventions/docs](../packages/commit-conventions/docs/README.md)   |
| `@holtkeeper/bundles`             | Size of app builds and published packages per entrypoint and release          | [packages/bundles/docs](../packages/bundles/docs/README.md)                         |
| `@holtkeeper/depgraph`            | Dependency graphs, cycles, duplicate versions                                 | [packages/depgraph/docs](../packages/depgraph/docs/README.md)                       |
| `@holtkeeper/depgraph-js`         | JS workspaces, lockfiles, module imports                                      | [packages/depgraph-js/docs](../packages/depgraph-js/docs/README.md)                 |
| `@holtkeeper/depgraph-go`         | Go workspaces and module graph                                                | [packages/depgraph-go/docs](../packages/depgraph-go/docs/README.md)                 |
| `@holtkeeper/go-source`           | Go source knowledge: modules, go.mod, API scan, import usages, tags           | [packages/go-source/docs](../packages/go-source/docs/README.md)                     |
| `@holtkeeper/quality`             | Contract for checks on a checkout and the runner that merges them             | [packages/quality/docs](../packages/quality/docs/README.md)                         |
| `@holtkeeper/quality-tests`       | Test framework detection and coverage collection                              | [packages/quality-tests/docs](../packages/quality-tests/docs/README.md)             |
| `@holtkeeper/quality-secrets`     | Leaked secrets (gitleaks)                                                     | [packages/quality-secrets/docs](../packages/quality-secrets/docs/README.md)         |
| `@holtkeeper/review`              | AI review of merge requests, thread replies                                   | [packages/review/docs](../packages/review/docs/README.md)                           |
| `@holtkeeper/guide`               | Team rules per scope and section, families, the prompt resolver               | [packages/guide/docs](../packages/guide/docs/README.md)                             |
| `@holtkeeper/guide-generator`     | The `guide` analyzer: evidence, hash-gated generation, proposals              | [packages/guide-generator/docs](../packages/guide-generator/docs/README.md)         |
| `@holtkeeper/coverage`            | Test coverage per source file, folder treemap and trend                       | [packages/coverage/docs](../packages/coverage/docs/README.md)                       |
| `@holtkeeper/testids`             | Catalog of test attributes per component; the review's test id check          | [packages/testids/docs](../packages/testids/docs/README.md)                         |
| `@holtkeeper/api-surface`         | Public API of packages per version, diffs, Markdown for agents                | [packages/api-surface/docs](../packages/api-surface/docs/README.md)                 |
| `@holtkeeper/usages`              | Which exports, members and props of packages each repository uses             | [packages/usages/docs](../packages/usages/docs/README.md)                           |
| `@holtkeeper/libraries`           | Third-party library versions, docs, API and issues for agents                 | [packages/libraries/docs](../packages/libraries/docs/README.md)                     |
| `@holtkeeper/licenses`            | Dependency licenses against an allowlist                                      | [packages/licenses/docs](../packages/licenses/docs/README.md)                       |
| `@holtkeeper/stack`               | Runtimes, images and tools across repositories, end of life, conventions      | [packages/stack/docs](../packages/stack/docs/README.md)                             |
| `@holtkeeper/release`             | Release assistant: next version, changelog, candidate MR, tags, deploys       | [packages/release/docs](../packages/release/docs/README.md)                         |
| `@holtkeeper/issues`              | Issue tracker contract: titles and status of ticket keys, cached lookups      | [packages/issues/docs](../packages/issues/docs/README.md)                           |
| `@holtkeeper/issues-jira`         | Read-only Jira Cloud and Data Center issue tracker                            | [packages/issues-jira/docs](../packages/issues-jira/docs/README.md)                 |
| `@holtkeeper/branches`            | Branches to clean up: merged, closed unmerged or stale                        | [packages/branches/docs](../packages/branches/docs/README.md)                       |
| `@holtkeeper/browserslist`        | Browserslist database updates as merge requests                               | [packages/browserslist/docs](../packages/browserslist/docs/README.md)               |
| `@holtkeeper/renovate`            | Renovate run per repository: outdated dependencies and update MRs             | [packages/renovate/docs](../packages/renovate/docs/README.md)                       |
| `@holtkeeper/ci-jobs`             | CI pipeline time, success rate and problem jobs from stored history           | [packages/ci-jobs/docs](../packages/ci-jobs/docs/README.md)                         |
| `@holtkeeper/assets`              | Asset sizes, budgets, format suggestions                                      | [packages/assets/docs](../packages/assets/docs/README.md)                           |
| `@holtkeeper/i18n`                | Translation gaps and placeholders                                             | [packages/i18n/docs](../packages/i18n/docs/README.md)                               |
| `@holtkeeper/agent-tools`         | Token-efficient agent tools with hard output budgets                          | [packages/agent-tools/docs](../packages/agent-tools/docs/README.md)                 |
| `@holtkeeper/knowledge`           | Team knowledge base rules: validation, dedup, picking entries                 | [packages/knowledge/docs](../packages/knowledge/docs/README.md)                     |
| `@holtkeeper/knowledge-bootstrap` | Starter knowledge from code and merge requests, placed by the scope agreement | [packages/knowledge-bootstrap/docs](../packages/knowledge-bootstrap/docs/README.md) |
| `@holtkeeper/limits`              | Per-credential limits: concurrency, rates, daily caps                         | [packages/limits/docs](../packages/limits/docs/README.md)                           |
| `@holtkeeper/exec-container`      | Command runners in containers or on the host through mise                     | [packages/exec-container/docs](../packages/exec-container/docs/README.md)           |
| `@holtkeeper/toolchain`           | Tools and versions a repository needs, from its files                         | [packages/toolchain/docs](../packages/toolchain/docs/README.md)                     |
| `@holtkeeper/ssh-keys`            | Bot SSH keys: generation, forge registration, signing                         | [packages/ssh-keys/docs](../packages/ssh-keys/docs/README.md)                       |
| `@holtkeeper/media`               | Image and SVG optimization engine (sharp, svgo)                               | [packages/media/docs](../packages/media/docs/README.md)                             |
| `@holtkeeper/mr-policies`         | Merge request policies: conditions and actions on MR events                   | [packages/mr-policies/docs](../packages/mr-policies/docs/README.md)                 |
| `@holtkeeper/propagate`           | Package updates rolled out across a group, failures handed to fix tasks       | [packages/propagate/docs](../packages/propagate/docs/README.md)                     |
| `@holtkeeper/write-task`          | Agent code changes on the write worker pool: branch, checks, merge request    | [packages/write-task/docs](../packages/write-task/docs/README.md)                   |
| `@holtkeeper/tracker`             | Declarative tracking of entities across repositories and docs                 | [packages/tracker/docs](../packages/tracker/docs/README.md)                         |
| `@holtkeeper/confluence`          | Confluence as a document source and sink for trackers                         | [packages/confluence/docs](../packages/confluence/docs/README.md)                   |

Test projects with known vulnerabilities live in [fixtures](../fixtures/README.md).
