# Documentation

## Project

- [Plan](PLAN.md) — goals, architecture and milestones
- [Development](development.md) — tooling, conventions, why there is no build step
- [Deployment](deployment.md) — Docker, compose, Kubernetes (Helm), roles, scaling, backups

## Modules

| Module                            | Role                                                                   | Docs                                                                                |
| --------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@holtkeeper/cli`                 | `holtkeeper` command                                                   | [apps/cli/docs](../apps/cli/docs/README.md)                                         |
| `@holtkeeper/server`              | HTTP API, auth endpoints, jobs, web UI hosting                         | [apps/server/docs](../apps/server/docs/README.md)                                   |
| `@holtkeeper/web`                 | Admin panel (HeroUI)                                                   | [apps/web/docs](../apps/web/docs/README.md)                                         |
| `@holtkeeper/core`                | Config, plugin contract, repository resolution                         | [packages/core/docs](../packages/core/docs/README.md)                               |
| `@holtkeeper/api`                 | HTTP contract shared by server and clients                             | [packages/api/docs](../packages/api/docs/README.md)                                 |
| `@holtkeeper/access`              | Grants, scopes, permission checks, delegation                          | [packages/access/docs](../packages/access/docs/README.md)                           |
| `@holtkeeper/auth`                | Auth provider contract, sessions                                       | [packages/auth/docs](../packages/auth/docs/README.md)                               |
| `@holtkeeper/auth-none`           | No sign-in, single root user                                           | [packages/auth-none/docs](../packages/auth-none/docs/README.md)                     |
| `@holtkeeper/auth-header`         | Users and grants from proxy headers                                    | [packages/auth-header/docs](../packages/auth-header/docs/README.md)                 |
| `@holtkeeper/brand`               | Mascot and capability icons (SVG) for the web UI and docs site         | [packages/brand/docs](../packages/brand/docs/README.md)                             |
| `@holtkeeper/auth-password`       | Root behind a password                                                 | [packages/auth-password/docs](../packages/auth-password/docs/README.md)             |
| `@holtkeeper/auth-users`          | Users with passkeys and OIDC, invites, recovery                        | [packages/auth-users/docs](../packages/auth-users/docs/README.md)                   |
| `@holtkeeper/identities`          | External accounts linked to principals, challenges, external actors    | [packages/identities/docs](../packages/identities/docs/README.md)                   |
| `@holtkeeper/store`               | Persistence contract, memory store, contract tests                     | [packages/store/docs](../packages/store/docs/README.md)                             |
| `@holtkeeper/store-sqlite`        | SQLite store                                                           | [packages/store-sqlite/docs](../packages/store-sqlite/docs/README.md)               |
| `@holtkeeper/store-postgres`      | PostgreSQL store                                                       | [packages/store-postgres/docs](../packages/store-postgres/docs/README.md)           |
| `@holtkeeper/vault`               | Encryption of secrets at rest                                          | [packages/vault/docs](../packages/vault/docs/README.md)                             |
| `@holtkeeper/settings`            | Scoped settings and their resolution                                   | [packages/settings/docs](../packages/settings/docs/README.md)                       |
| `@holtkeeper/credentials`         | Credential service, rotation scheduling                                | [packages/credentials/docs](../packages/credentials/docs/README.md)                 |
| `@holtkeeper/forge`               | Git hosting contract                                                   | [packages/forge/docs](../packages/forge/docs/README.md)                             |
| `@holtkeeper/forge-gitlab`        | GitLab adapter and token rotation                                      | [packages/forge-gitlab/docs](../packages/forge-gitlab/docs/README.md)               |
| `@holtkeeper/exec`                | Command execution contract                                             | [packages/exec/docs](../packages/exec/docs/README.md)                               |
| `@holtkeeper/workspace`           | Repository checkouts with a mirror cache                               | [packages/workspace/docs](../packages/workspace/docs/README.md)                     |
| `@holtkeeper/jobs`                | Task engine: queue, scheduler, worker                                  | [packages/jobs/docs](../packages/jobs/docs/README.md)                               |
| `@holtkeeper/updates`             | Polling forges for changes within a per-token budget                   | [packages/updates/docs](../packages/updates/docs/README.md)                         |
| `@holtkeeper/managed-config`      | Panel-managed forges, groups, schedules, triggers over the config file | [packages/managed-config/docs](../packages/managed-config/docs/README.md)           |
| `@holtkeeper/agent`               | LLM agent contract and Claude adapter                                  | [packages/agent/docs](../packages/agent/docs/README.md)                             |
| `@holtkeeper/ai-usage`            | AI usage recording, costs and budgets                                  | [packages/ai-usage/docs](../packages/ai-usage/docs/README.md)                       |
| `@holtkeeper/ai-waibee`           | Waibee Router as an AI provider plugin                                 | [packages/ai-waibee/docs](../packages/ai-waibee/docs/README.md)                     |
| `@holtkeeper/notify`              | Notifications: Slack and webhooks                                      | [packages/notify/docs](../packages/notify/docs/README.md)                           |
| `@holtkeeper/report`              | Universal report format and analysis kinds                             | [packages/report/docs](../packages/report/docs/README.md)                           |
| `@holtkeeper/artifacts`           | Content-addressed blob store (fs, memory, S3), ZIP, storage providers  | [packages/artifacts/docs](../packages/artifacts/docs/README.md)                     |
| `@holtkeeper/changes`             | Suggested code changes: apply, diff, patch, merge request              | [packages/changes/docs](../packages/changes/docs/README.md)                         |
| `@holtkeeper/analyzer`            | Analyzer contract shared by CLI and task engine                        | [packages/analyzer/docs](../packages/analyzer/docs/README.md)                       |
| `@holtkeeper/analyzers`           | Registry of built-in analyzers                                         | [packages/analyzers/docs](../packages/analyzers/docs/README.md)                     |
| `@holtkeeper/vuln`                | Vulnerability audit contracts, allowlist, orchestration                | [packages/vuln/docs](../packages/vuln/docs/README.md)                               |
| `@holtkeeper/vuln-osv`            | OSV-Scanner scanner and fixer                                          | [packages/vuln-osv/docs](../packages/vuln-osv/docs/README.md)                       |
| `@holtkeeper/vuln-js`             | npm/bun/pnpm/yarn fixer                                                | [packages/vuln-js/docs](../packages/vuln-js/docs/README.md)                         |
| `@holtkeeper/vuln-go`             | Go modules fixer                                                       | [packages/vuln-go/docs](../packages/vuln-go/docs/README.md)                         |
| `@holtkeeper/changelog`           | Release analysis: commit history, grouping, links                      | [packages/changelog/docs](../packages/changelog/docs/README.md)                     |
| `@holtkeeper/bundles`             | Build size per entrypoint and package                                  | [packages/bundles/docs](../packages/bundles/docs/README.md)                         |
| `@holtkeeper/depgraph`            | Dependency graphs, cycles, duplicate versions                          | [packages/depgraph/docs](../packages/depgraph/docs/README.md)                       |
| `@holtkeeper/depgraph-js`         | JS workspaces, lockfiles, module imports                               | [packages/depgraph-js/docs](../packages/depgraph-js/docs/README.md)                 |
| `@holtkeeper/depgraph-go`         | Go workspaces and module graph                                         | [packages/depgraph-go/docs](../packages/depgraph-go/docs/README.md)                 |
| `@holtkeeper/quality`             | Code quality contract, merging checks, report                          | [packages/quality/docs](../packages/quality/docs/README.md)                         |
| `@holtkeeper/quality-conventions` | Naming conventions inferred per project (ast-grep)                     | [packages/quality-conventions/docs](../packages/quality-conventions/docs/README.md) |
| `@holtkeeper/quality-tests`       | Coverage, test gaps, example tests                                     | [packages/quality-tests/docs](../packages/quality-tests/docs/README.md)             |
| `@holtkeeper/quality-lint`        | Linters through SARIF with their fixes                                 | [packages/quality-lint/docs](../packages/quality-lint/docs/README.md)               |
| `@holtkeeper/quality-duplication` | Duplicated code (jscpd)                                                | [packages/quality-duplication/docs](../packages/quality-duplication/docs/README.md) |
| `@holtkeeper/quality-deadcode`    | Dead code: unused files, exports, dependencies (knip)                  | [packages/quality-deadcode/docs](../packages/quality-deadcode/docs/README.md)       |
| `@holtkeeper/quality-secrets`     | Leaked secrets (gitleaks)                                              | [packages/quality-secrets/docs](../packages/quality-secrets/docs/README.md)         |
| `@holtkeeper/review`              | AI review of merge requests, thread replies                            | [packages/review/docs](../packages/review/docs/README.md)                           |
| `@holtkeeper/coverage`            | Test coverage per source file, folder treemap and trend                | [packages/coverage/docs](../packages/coverage/docs/README.md)                       |
| `@holtkeeper/testids`             | Test id attributes on interactive elements of frontend templates       | [packages/testids/docs](../packages/testids/docs/README.md)                         |
| `@holtkeeper/licenses`            | Dependency licenses against an allowlist                               | [packages/licenses/docs](../packages/licenses/docs/README.md)                       |
| `@holtkeeper/fleet`               | Library versions and config drift across repositories                  | [packages/fleet/docs](../packages/fleet/docs/README.md)                             |
| `@holtkeeper/release-risk`        | Release risk score and summary                                         | [packages/release-risk/docs](../packages/release-risk/docs/README.md)               |
| `@holtkeeper/branches`            | Branches to clean up: merged, closed unmerged or stale                 | [packages/branches/docs](../packages/branches/docs/README.md)                       |
| `@holtkeeper/delivery`            | DORA metrics and CI health                                             | [packages/delivery/docs](../packages/delivery/docs/README.md)                       |
| `@holtkeeper/ci-jobs`             | CI job durations, slowdowns and failure rates from stored history      | [packages/ci-jobs/docs](../packages/ci-jobs/docs/README.md)                         |
| `@holtkeeper/assets`              | Asset sizes, budgets, format suggestions                               | [packages/assets/docs](../packages/assets/docs/README.md)                           |
| `@holtkeeper/i18n`                | Translation gaps and placeholders                                      | [packages/i18n/docs](../packages/i18n/docs/README.md)                               |

Test projects with known vulnerabilities live in [fixtures](../fixtures/README.md).
