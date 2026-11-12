# @holtkeeper/core

Configuration and repository resolution. Everything else in Holtkeeper builds on this package.

## Configuration

A configuration is a TypeScript module whose default export is passed through `defineConfig`. It holds infrastructure only; forges, groups, repository traits, schedules, triggers and every other setting are panel documents and settings in the store ([@holtkeeper/managed-config](../../managed-config/docs/README.md)).

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

| Field    | Description                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server` | Sign-in, store, vault key, listener, `publicUrl`, artifacts and their retention, the egress rules secret, credential rotation; see [@holtkeeper/server](../../../apps/server/docs/README.md).  |
| `jobs`   | The worker: `execution` (mode, image, limits, egress proxy, environment allowlist), `concurrency`, `cacheDir`, `timeoutMinutes`, and the shared `webhookSecret`. Always present after parsing. |
| `limits` | `distributed`: keep credential limiter counters in the store so several processes share them.                                                                                                  |
| `ai`     | `providers`: AI provider plugins (`AiProviderPlugin` of [@holtkeeper/agent](../../agent/docs/README.md#provider-plugins)) that `ai-sdk` credentials may name by `package`, each package once.  |
| `dryRun` | When `true`, jobs report what they would do without changing anything. Default `false`.                                                                                                        |

### Removed keys

`removedConfigKeys` lists what a config file no longer takes, with where it is edited now (the panel place and its path from [@holtkeeper/web-paths](../../web-paths/docs/README.md), e.g. `Settings › Integrations, /settings/integrations`): `forges`, `groups`, `repos`, `plugins`, `jobs.schedules`, `jobs.onTag`, `jobs.onPush`, `jobs.onMergeRequest`, `jobs.onNewRepo`, `jobs.onLabel`, `jobs.commands`, `jobs.botUsername` and `jobs.webhooks`. `parseConfigFile` and `loadConfig` warn once per such key (through `warn`, default `console.warn`) and ignore it; nothing is imported.

### Effective config

`HoltkeeperConfig` is what the server runs on: the file config plus `forges`, `groups`, `repos` (traits by path glob) and the `jobs` entries panel documents produce (`schedules`, `onTag`, `onPush`, `onMergeRequest`, `onNewRepo`, `onLabel`, `commands`, `botUsernames` by forge id, `webhooks` by forge id). `@holtkeeper/managed-config` builds it; `parseConfig` validates one. Globs follow `Bun.Glob`: `*` stays within one path segment, `**` crosses segments. `games/*` matches `games/app-x` but not `games/web/app-x`.

### Group lists

A repository can belong to any number of groups, so groups double as tags: one set by layer (`frontend`, `backend`), another by product (`storefront`, `admin-panel`, `catalog`). Every list of groups in the effective config (schedule `groups`, `jobs.onTag.groups`, `jobs.onPush.groups`, `jobs.onMergeRequest.groups`, `jobs.onNewRepo.groups`) and every access, settings and knowledge `Scope` takes `GroupMatch` entries from [@holtkeeper/access](../../access/docs/README.md): a group name, or a list of groups a repository must all belong to. Entries combine with OR, groups inside an entry with AND:

```text
// groups (panel documents)
frontend: { forge: 'work', include: ['shop/web', 'admin/*-ui'] }
storefront: { forge: 'work', include: ['shop/**'] }
'admin-panel': { forge: 'work', include: ['admin/**'] }
catalog: { forge: 'work', include: ['admin/catalog-*', 'shop/catalog-*'] }

// schedule groups
['frontend'] // every frontend
[['frontend', 'storefront'], ['frontend', 'admin-panel', 'catalog']] // storefront frontends, plus admin panel frontends of the catalog
```

A group may have a `title` (trimmed, 1–60 characters) that people see instead of its key. The key stays the identity: grants, settings scopes, home groups, guides, schedules and triggers name groups by key only. `groupTitle(groups, key)` returns the title, or the key when there is none; `groupLabel(groups, key)` returns `Title (key)` for text a reader may act on (chat, agent and MCP output), so the key is always at hand.

Group-scope analyzers of a schedule or `onTag` run only for single-group entries: an intersection has no group of its own to report on.

### Subgroups

A group key is a root group (`shapes`) or a subgroup one level below it (`shapes.round`): lowercase letters, digits and dashes with at most one dot (`groupKeySchema`, `GROUP_KEY_PATTERN` of `@holtkeeper/access`). The parent comes from the key; there is no stored parent field, so a key's meaning never changes and cycles cannot exist. Moving a subgroup to another parent means creating a new key.

- A subgroup's parent must be configured (`parent group "shapes" is not configured`, reported at `groups.<key>`) and its `forge` must equal the parent's (`forge must match parent "shapes"`).
- A repository is in `shapes.round` when the subgroup's own include/exclude match it **and** it is a member of `shapes`. A subgroup is never wider than its parent, so every `groups: ['shapes']` grant, setting, note and trigger keeps covering its members.
- Sibling subgroups may overlap.
- `rootGroups(config)` lists the keys that are not subgroups and `subgroupsOf(config, key)` the subgroups of one group, both in config order. `groupPathLabel(groups, key)` shows a group with its ancestors' titles: `Shapes › Round (shapes.round)`; `groupLabel` uses it for subgroups.

```text
shapes: { title: 'Shapes', forge: 'work', include: ['shapes/*'], exclude: ['shapes/legacy-*'] }
'shapes.round': { title: 'Round', forge: 'work', include: ['shapes/circle-*'] }
// shapes/circle-a     → ['shapes.round', 'shapes']
// shapes/legacy-circle → [] (not in the parent, so not in the subgroup)
```

### Secrets

`env('NAME')` stores a reference to an environment variable. It is read when the value is used, not when the config loads, so a config validates without secrets.

### Validation

`loadConfig(file, { warn? })` imports the module and validates it with `parseConfigFile(value, { warn? })`; both throw `ConfigError` with every problem listed by path (for example the same AI provider package added twice). `parseConfig(value)` validates an effective config and also reports:

- unknown forge or group references, including groups inside intersections;
- subgroup keys deeper than one level, subgroups without their parent and subgroups on another forge than the parent;
- schedules defined twice and invalid cron, intervals, time zones or windows.

## Resolution

`resolveRepo(config, { forge, path })` answers "what applies to this repository":

- `groups` — groups whose forge and globs match (for a subgroup, also its parent's), each subgroup listed directly before its parent, so the list always holds every group's full lineage;
- `traits` — merged traits from matching `repos` entries.
