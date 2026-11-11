---
title: Getting started
description: Run Holtkeeper from source and start the server.
sidebar:
  order: 0
---

Holtkeeper is a self-hosted automation engine for fleets of GitLab and GitHub repositories. Everything it does — review, audits, dependency waves, release analyses — runs on a server that queues the work on webhooks and schedules. People use its panel; AI agents use its MCP endpoint.

## Requirements

- [Bun](https://bun.sh) 1.4. Holtkeeper has no build step: packages export TypeScript source and Bun runs it directly.
- [mise](https://mise.jdx.dev) for the tools jobs call: `osv-scanner`, `gitleaks`, Go and pnpm are pinned in `mise.toml`.

## Run from source

```sh
git clone https://github.com/holtkeeper/holtkeeper
cd holtkeeper
mise install
bun install
bun apps/cli/src/bin.ts --help
```

`bun install` also sets up the git hooks. The rest of this page writes `holtkeeper` for `bun apps/cli/src/bin.ts`.

## Describe your fleet

The server reads `holtkeeper.config.ts`, which holds infrastructure only: sign-in, the store, the vault key and the worker.

```ts
import { passwordAuth } from '@holtkeeper/auth-password'
import { defineConfig, env } from '@holtkeeper/core'
import { sqliteStore } from '@holtkeeper/store-sqlite'

export default defineConfig({
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
holtkeeper serve
```

`serve` validates the file and starts the API, the admin panel and the task engine on port 7420. Sign in, store the GitLab token as a credential, add the forge and group your repositories in the panel: forges, groups, triggers and analyzer options live in the database. [@holtkeeper/core](/modules/core/) documents the config and [@holtkeeper/server](/modules/server/) the `server` section. For containers, `deploy/` holds a Docker Compose file and a Helm chart that run the same image as `web`, `worker` and `scheduler` processes. `holtkeeper users` manages accounts of passkey sign-in; see [@holtkeeper/cli](/modules/cli/).

## Next

- [Plan](/guide/plan/) — principles, architecture and milestones.
- [Development](/guide/development/) — tooling and conventions for contributors.
- [Modules](/modules/) — every package with its contract and options.
