---
title: Getting started
description: Run Holtkeeper from source, audit a checkout, then start the server.
sidebar:
  order: 0
---

Holtkeeper is a self-hosted automation engine for fleets of GitLab and GitHub repositories. Everything it does — review, audits, dependency waves, release analyses — runs from one command line and from a server that queues the same work on webhooks and schedules.

## Requirements

- [Bun](https://bun.sh) 1.4. Holtkeeper has no build step: packages export TypeScript source and Bun runs it directly.
- [mise](https://mise.jdx.dev) for the tools some commands call: `osv-scanner`, `gitleaks`, Go and pnpm are pinned in `mise.toml`.

## Run from source

```sh
git clone https://github.com/holtkeeper/holtkeeper
cd holtkeeper
mise install
bun install
bun apps/cli/src/bin.ts --help
```

`bun install` also sets up the git hooks. The rest of this page writes `holtkeeper` for `bun apps/cli/src/bin.ts`.

## Audit a checkout

`audit` scans a directory with OSV-Scanner and prints every finding that is not allowlisted. With `--fix` it runs the fixers in order — `osv-scanner fix`, then the JavaScript fixer (bun, pnpm, yarn, npm), then the Go fixer — and scans again.

```sh
holtkeeper audit ./path/to/checkout
holtkeeper audit ./path/to/checkout --fix --allowlist allowlist.json --trait ssr=false
```

It exits with `1` while unfixed findings remain, so it fits a CI job as is. See [@holtkeeper/cli](/modules/cli/) for every option and [@holtkeeper/vuln](/modules/vuln/) for the allowlist format.

## Run an analysis

`analyze <kind>` runs one analyzer and prints its report; `--json` prints the data instead.

```sh
holtkeeper analyze changelog . --from v2.3.0 --to v2.4.0
holtkeeper analyze depgraph .
holtkeeper analyze licenses . --deny 'GPL-*,AGPL-*'
```

`holtkeeper --help` lists every kind with its flags: `changelog`, `bundle`, `depgraph`, `quality`, `coverage`, `testids`, `licenses`, `release-risk`, `fleet`, `assets`, `delivery`, `i18n`, `propagate`, `port` and `review`. Analyzers that use an LLM take `--model` and need `ANTHROPIC_API_KEY`.

## Describe your fleet

Everything else reads `holtkeeper.config.ts`: forges, repository groups, plugins and the `server` section.

```ts
import { passwordAuth } from '@holtkeeper/auth-password'
import { defineConfig, env } from '@holtkeeper/core'
import { gitlab } from '@holtkeeper/forge-gitlab'
import { sqliteStore } from '@holtkeeper/store-sqlite'

export default defineConfig({
  forges: {
    work: gitlab({ url: 'https://gitlab.example.com', token: env('GITLAB_TOKEN') }),
  },
  groups: {
    games: { forge: 'work', include: ['games/*'], exclude: ['games/legacy-*'] },
  },
  server: {
    auth: passwordAuth({
      password: env('HOLTKEEPER_PASSWORD'),
      sessionSecret: env('HOLTKEEPER_SESSION_SECRET'),
    }),
    store: sqliteStore({ path: 'holtkeeper.db' }),
    vaultKey: env('HOLTKEEPER_VAULT_KEY'),
  },
})
```

```sh
holtkeeper validate-config
holtkeeper explain work:games/app-x
holtkeeper serve
```

`validate-config` checks the file without secrets, `explain` prints what applies to one repository, and `serve` starts the API, the admin panel and the task engine on port 7420. [@holtkeeper/core](/modules/core/) documents the config and [@holtkeeper/server](/modules/server/) the `server` section. For containers, `deploy/` holds a Docker Compose file and a Helm chart that run the same image as `web`, `worker` and `scheduler` processes.

## Next

- [Plan](/guide/plan/) — principles, architecture and milestones.
- [Development](/guide/development/) — tooling and conventions for contributors.
- [Modules](/modules/) — every package with its contract and options.
