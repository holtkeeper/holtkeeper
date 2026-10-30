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
    'games/slots-x': { traits: { ssr: true } },
  },
  plugins: [
    browserslist({
      groups: ['games'],
      options: { autoMerge: true },
      overrides: { 'games/slots-*': { autoMerge: false } },
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

Globs follow `Bun.Glob`: `*` stays within one path segment, `**` crosses segments. `games/*` matches `games/slots-x` but not `games/web/slots-x`.

### Secrets

`env('NAME')` stores a reference to an environment variable. It is read when the forge is created, not when the config loads, so `validate-config` works without secrets.

### Validation

`loadConfig(file)` imports the module and validates it; `parseConfig(value)` validates an object. Both throw `ConfigError` with every problem listed by path, including:

- unknown forge or group references;
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
- `plugins` — plugins targeting any of those groups and not excluding the path, with options merged from matching overrides and parsed by the plugin schema.

The CLI exposes this as `holtkeeper explain`.
