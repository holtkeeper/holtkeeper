# @holtkeeper/core

Configuration and repository resolution. Everything else in Holtkeeper builds on this package.

## Configuration

A configuration is a TypeScript module whose default export is passed through `defineConfig`. It holds infrastructure only; forges, teams, repository traits, schedules, triggers and every other setting are panel documents and settings in the store ([@holtkeeper/managed-config](../../managed-config/docs/README.md)).

```ts
import { passwordAuth } from '@holtkeeper/auth-password'
import { defineConfig, env } from '@holtkeeper/core'
import { postgresStore } from '@holtkeeper/store-postgres'

export default defineConfig({
  server: {
    auth: passwordAuth({ password: env('ROOT_PASSWORD'), sessionSecret: env('SESSION_SECRET') }),
    store: postgresStore({ url: env('DATABASE_URL') }),
    vaultKey: env('VAULT_KEY'),
  },
  jobs: { execution: { mode: 'mise' }, concurrency: 2, webhookSecret: env('WEBHOOK_SECRET') },
  limits: { distributed: true },
})
```

| Field    | Description                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server` | Sign-in, store, vault key, listener, `publicUrl`, artifacts and their retention, the egress rules secret, credential rotation; see [@holtkeeper/server](../../../apps/server/docs/README.md).                   |
| `jobs`   | The worker: `execution` (mode, image, limits, egress proxy, environment allowlist), `concurrency`, `prioritySlots`, `cacheDir`, `timeoutMinutes`, and the shared `webhookSecret`. Always present after parsing. |
| `limits` | `distributed`: keep credential limiter counters in the store so several processes share them.                                                                                                                   |
| `ai`     | `providers`: AI provider plugins (`AiProviderPlugin` of [@holtkeeper/agent](../../agent/docs/README.md#provider-plugins)) that `ai-sdk` credentials may name by `package`, each package once.                   |
| `dryRun` | When `true`, jobs report what they would do without changing anything. Default `false`.                                                                                                                         |

### Removed keys

`removedConfigKeys` lists what a config file no longer takes, with where it is edited now (the panel place and its path from [@holtkeeper/web-paths](../../web-paths/docs/README.md), e.g. `Settings › Integrations, /settings/integrations`): `forges`, `groups`, `repos`, `plugins`, `jobs.schedules`, `jobs.onTag`, `jobs.onPush`, `jobs.onMergeRequest`, `jobs.onNewRepo`, `jobs.onLabel`, `jobs.commands`, `jobs.botUsername` and `jobs.webhooks`. `parseConfigFile` and `loadConfig` warn once per such key (through `warn`, default `console.warn`) and ignore it; nothing is imported.

### Effective config

`HoltkeeperConfig` is what the server runs on: the file config plus `forges`, `teams`, `repos` (traits by path glob) and the `jobs` entries panel documents produce (`schedules`, `onTag`, `onPush`, `onMergeRequest`, `onNewRepo`, `onLabel`, `commands`, `botUsernames` by forge id, `webhooks` by forge id). `@holtkeeper/managed-config` builds it; `parseConfig` validates one. Globs follow `Bun.Glob`: `*` stays within one path segment, `**` crosses segments. `games/*` matches `games/app-x` but not `games/web/app-x`.

### Teams and path patterns

Repositories are organised by the forge's own folders and by teams; see [docs/teams-and-paths.md](../../../docs/teams-and-paths.md) for the model. `teams` of the effective config holds one entry per team key (flat, `teamKeySchema` of [@holtkeeper/access](../../access/docs/README.md)): `{ title?, owns, exclude, consumes, members }`. `owns`, `exclude` and `consumes` are path patterns, optionally forge-qualified (`work:acme/**`); a bare pattern matches every forge. A repository may be owned by several teams (a shared library) or by none.

```text
// teams (panel documents)
gizmo: { title: 'Gizmo crew', owns: ['acme/round/**', 'acme/square/**'], consumes: ['acme/shared/**'],
         members: [{ id: 'ada', role: 'maintainer' }] }
kit:   { owns: ['work:acme/shared/**'], exclude: ['acme/shared/legacy-*'] }
```

Schedules and the `onTag`, `onPush`, `onMergeRequest` and `onNewRepo` triggers take `teams` (keys) and `repos` (path patterns, e.g. `acme/*/game-frontend`); a repository matching either is covered, and every repository when both are absent. Group-scope analyzers of a schedule or `onTag` run once per listed team.

**Fleet.** The repositories Holtkeeper works on are those matching `fleetPatterns(config, forge)`: the forge document's `include` globs (`fleet.<forge>`) plus every team's `owns` and `consumes` pattern that applies to the forge, minus the forge's `exclude`. A repository nobody owns is in the fleet only through a forge include. Fleet includes and team `owns`/`consumes` patterns must start with a literal namespace (`acme/**`, not `**/web`), because listing walks forge namespaces; excludes may be anything.

The key stays the identity: grants, settings scopes, home teams, guides, schedules and triggers name teams by key only. `teamTitle(teams, key)` returns the title, or the key when there is none; `teamLabel(teams, key)` returns `Title (key)` for text a reader may act on (chat, agent and MCP output), so the key is always at hand.

### Secrets

`env('NAME')` stores a reference to an environment variable. It is read when the value is used, not when the config loads, so a config validates without secrets.

### Validation

`loadConfig(file, { warn? })` imports the module and validates it with `parseConfigFile(value, { warn? })`; both throw `ConfigError` with every problem listed by path (for example the same AI provider package added twice). `parseConfig(value)` validates an effective config and also reports:

- unknown team references and unknown forges in forge-qualified patterns (teams, schedules, triggers);
- team keys that are not flat keys and teams without `owns`;
- schedules defined twice and invalid cron, intervals, time zones or windows.

## Resolution

`resolveRepo(config, { forge, path })` answers "what applies to this repository":

- `teams` — every team whose `owns` matches and whose `exclude` does not, in config order;
- `consumers` — teams whose `consumes` matches and that do not own it;
- `traits` — merged traits from matching `repos` entries.
