# @holtkeeper/core

Configuration, the plugin contract and repository resolution. Everything else in Holtkeeper builds on this package.

## Configuration

A configuration is a TypeScript module whose default export is passed through `defineConfig`:

```ts
import { defineConfig, env } from '@holtkeeper/core'
import { gitlab } from '@holtkeeper/forge-gitlab'
import { browserslist } from '@holtkeeper/plugin-browserslist'

export default defineConfig({
  forges: {
    work: gitlab({ url: 'https://gitlab.example.com', token: env('GITLAB_TOKEN') }),
  },
  groups: {
    games: { forge: 'work', include: ['games/*'], exclude: ['games/legacy-*'] },
  },
  repos: {
    'games/*': { traits: { ssr: false } },
    'games/app-x': { traits: { ssr: true } },
  },
  plugins: [
    browserslist({
      groups: ['games'],
      options: { autoMerge: true },
      overrides: { 'games/app-*': { autoMerge: false } },
    }),
  ],
})
```

(`forge-gitlab` and the plugin are shown for illustration; they arrive in later milestones.)

| Field     | Description                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forges`  | Named Git hosting connections. Keys are lowercase ids.                                                                                                                                        |
| `groups`  | Named sets of repositories on one forge, selected by `include` and `exclude` globs over the repository path.                                                                                  |
| `repos`   | Traits per repository, keyed by a path glob. Optional `forge` limits the entry to one forge. Matching entries merge in declaration order, so put specific patterns after general ones.        |
| `plugins` | Plugin uses: which groups they run on, base `options`, `exclude` globs and per-path `overrides`.                                                                                              |
| `ai`      | `providers`: AI provider plugins (`AiProviderPlugin` of [@holtkeeper/agent](../../agent/docs/README.md#provider-plugins)) that `ai-sdk` credentials may name by `package`, each package once. |
| `dryRun`  | When `true`, plugins report what they would do without changing anything. Default `false`.                                                                                                    |

Globs follow `Bun.Glob`: `*` stays within one path segment, `**` crosses segments. `games/*` matches `games/app-x` but not `games/web/app-x`.

### Group lists

A repository can belong to any number of groups, so groups double as tags: one set by layer (`frontend`, `backend`), another by product (`storefront`, `admin-panel`, `catalog`). Every list of groups in the config (plugin `groups`, schedule `groups`, `jobs.onTag.groups`, `jobs.onPush.groups`, `jobs.onMergeRequest.groups`) and every access, settings and knowledge `Scope` takes `GroupMatch` entries from [@holtkeeper/access](../../access/docs/README.md): a group name, or a list of groups a repository must all belong to. Entries combine with OR, groups inside an entry with AND:

```ts
groups: {
  frontend: { forge: 'work', include: ['shop/web', 'admin/*-ui'] },
  storefront: { forge: 'work', include: ['shop/**'] },
  'admin-panel': { forge: 'work', include: ['admin/**'] },
  catalog: { forge: 'work', include: ['admin/catalog-*', 'shop/catalog-*'] },
},
plugins: [
  lint({ groups: ['frontend'] }), // every frontend
  bundleBudget({ groups: [['frontend', 'storefront']] }), // only storefront frontends
  // storefront frontends, plus admin panel frontends of the catalog
  e2e({ groups: [['frontend', 'storefront'], ['frontend', 'admin-panel', 'catalog']] }),
],
```

Group-scope analyzers of a schedule or `onTag` run only for single-group entries: an intersection has no group of its own to report on.

### Secrets

`env('NAME')` stores a reference to an environment variable. It is read when the forge is created, not when the config loads, so `validate-config` works without secrets.

### Validation

`loadConfig(file)` imports the module and validates it; `parseConfig(value)` validates an object. Both throw `ConfigError` with every problem listed by path, including:

- unknown forge or group references, including groups inside intersections;
- the same plugin used twice;
- plugin options that fail the plugin's schema, checked for the base options and for every override merged on top of them.

## Plugins

```ts
import { definePlugin, schedule } from '@holtkeeper/core'
import { z } from 'zod'

export const browserslist = definePlugin({
  name: 'browserslist',
  options: z.object({ autoMerge: z.boolean().default(false) }),
  triggers: [schedule('0 6 * * 1')],
  async run(ctx) {
    // ctx.repo, ctx.forge, ctx.options, ctx.traits, ctx.dryRun, ctx.signal
  },
})
```

`definePlugin` returns a factory that the config calls with targets and options. Option types come from the zod schema: the config accepts the schema's input type and `run` receives its parsed output.

Triggers: `schedule(cron)` and `command(name)`. Event triggers arrive with the server.

## Resolution

`resolveRepo(config, { forge, path })` answers "what applies to this repository":

- `groups` — groups whose forge and globs match;
- `traits` — merged traits from matching `repos` entries;
- `plugins` — plugins whose `groups` match those groups (any entry, every group of an intersection) and not excluding the path, with options merged from matching overrides and parsed by the plugin schema.

The CLI exposes this as `holtkeeper explain`.
