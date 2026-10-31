# @holtkeeper/managed-config

Forges, groups, repository traits, schedules and triggers edited in the panel, layered over `holtkeeper.config.ts`. Panel entries are typed documents in `store.config` (`ConfigStore` from `@holtkeeper/store`); this package turns the file config plus those documents into the config the server runs on, keeps it current and exports it back to TypeScript.

## Documents

| Type         | Id                                                                              | Data                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `forge`      | forge id (`work`)                                                               | `{ kind: 'gitlab' \| 'github', url, credentialId, packages?, webhook?: { secret (sealed), createdAt, registered? } }`            |
| `group`      | group id                                                                        | `{ forge, include[], exclude[] }`                                                                                                |
| `repoTraits` | free; merged by `pattern`                                                       | `{ pattern, forge?, traits }`                                                                                                    |
| `schedule`   | the schedule's config `name`                                                    | `{ name (display), enabled, analyzers, groups?, repos?, options?, cron \| every, timezone?, windows?, jitterMinutes?, spread? }` |
| `trigger`    | `tag`, `push`, `merge-request`, `label:<label>`, `command:<name>` (`triggerId`) | `{ on: 'tag' \| 'push' \| 'mergeRequest' \| 'label' \| 'command', ... }` as the matching `jobs` entry                            |

Every document has `version` (1, 2, …), `updatedAt`, `updatedBy`; earlier versions stay in `history(type, id)` until the document is removed. Body schemas for the panel's endpoints are in `documentDataSchemas`; they use the file config's rules (ids, cron checked with croner, `every` like `15m`/`1h`/`1d`, IANA zones, `HH:MM` windows). A forge's token is never in a document: `credentialId` points at a stored credential.

## Precedence

`effectiveConfig(file, documents, { forgeFactories, tokens?, webhookSecrets?, reuse? })`:

- A document **replaces** the file entry with the same key — forges and groups by id, schedules by name, repo traits by pattern, triggers by trigger id (`onTag`, `onPush`, `onMergeRequest`, `onLabel[label]`, `commands[name]`) — or **adds** a new one. Panel documents cannot delete file entries; a panel schedule with `enabled: false` switches a file schedule off.
- Panel forges are built by `forgeFactories[kind](doc, token)` with the credential's plaintext token from `tokens`. A missing token or adapter gives a forge whose `create()` throws, so only tasks using it fail.
- A panel forge with a webhook secret (opened, in `webhookSecrets`) becomes `jobs.webhooks.<id>.secret`.
- Panel schedules, triggers and webhook secrets create a `jobs` section with defaults when the file has none (the server only starts its job engine for a config that has `jobs` at start).
- The result is validated with `parseConfig`; any rule of the file config (unknown forge, unknown group, duplicate schedule, plugin options) throws `ConfigError`.

`gitlabForgeFactory({ fetchFor? })` is the GitLab factory (`gitlab({ url, token, fetch })`).

## Provenance

`EffectiveConfig.provenance` maps `<type>:<key>` to `file`, `panel` or `file+panel` (a panel document overrides a file entry): `forge:work`, `group:games`, `repoTraits:games/*`, `schedule:nightly`, `trigger:label:port`. `forges` lists each forge's `kind`, `url` and, for panel forges, `credentialId`.

## ConfigSource

```ts
const source = await createConfigSource({
  file, // validated file config
  store: store.config, // optional: without it the file config is served as is
  forgeFactories: { gitlab: gitlabForgeFactory() },
  revealToken: (credentialId) => credentials.reveal(credentialId),
  openSecret: (sealed) => vault.open(sealed),
  pollMs: 60_000, // optional periodic rebuild (rotated tokens, other processes)
})
source.current() // HoltkeeperConfig
source.subscribe((effective) => …) // after each rebuild that changed something
await source.refresh() // rebuild now, e.g. after a write
await source.preview({ put }) // the config a change would give, throws ConfigError when invalid
```

A rebuild that fails validation keeps the previous config (`lastError()`). Panel forge definitions are cached per document version and token, and each builds its `GitForge` client once (`memoizeForge`). `liveConfig(source)` is a config object that reads `source.current()` on every property access, for code that captures a config once.

## Defaults

`seedDefaults({ store, file, analyzers })` writes each of `defaultSchedules` and `defaultTriggers` as a panel document the first time a store sees it, so a release that adds defaults adds them to existing installs too. Each document is considered once (marker `config:default-seeded:<type>:<id>` in `Store.kv`, taken atomically when the store supports `compareAndSet`): removing it later does not bring it back, and a panel document with the same id stays as it is. Stores seeded by the first version (marker `config:default-schedules-seeded`) count its three schedules as considered. Schedules are skipped while the file has its own, the tag trigger while the file sets `jobs.onTag`; analyzers the server lacks are dropped. Logged as `config.defaults.seeded`.

Every default schedule covers all groups and spreads its repository jobs over 01:00–07:00 (server time zone):

| Id                    | Analyzers                                                            | When             |
| --------------------- | -------------------------------------------------------------------- | ---------------- |
| `ci-jobs-nightly`     | `ci-jobs`                                                            | every night      |
| `delivery-weekly`     | `delivery`                                                           | Monday nights    |
| `security-weekly`     | `audit`, `depgraph`                                                  | Saturday nights  |
| `quality-weekly`      | `quality` (`coverage: skip`, so no test runs), `licenses`, `fleet`   | Sunday nights    |
| `tests-weekly`        | `coverage`, `testids`                                                | Wednesday nights |
| `branches-weekly`     | `branches`                                                           | Tuesday nights   |
| `stack-weekly`        | `stack`                                                              | Monday nights    |
| `api-weekly`          | `api-surface`                                                        | Thursday nights  |
| `usages-weekly`       | `usages`                                                             | Thursday nights  |
| `assets-weekly`       | `assets`                                                             | Friday nights    |
| `browserslist-weekly` | `browserslist` (only repositories whose lockfile has `caniuse-lite`) | Tuesday nights   |

The default trigger `tag` queues `changelog`, `release-risk` and `api-surface` for every new or moved tag, from webhooks or polling. `defaultTriggerAdditions` bring analyzers added to a default trigger later to installs that already have it: each addition appends its missing analyzers to the existing document once (marker `config:default-seeded:trigger:<id>`, e.g. `tag+api-surface`), so taking one out again in the panel sticks.

## Export

`exportConfig(effective)` returns the source of a `holtkeeper.config.ts` with the effective forges, groups, repos and `jobs`:

- deterministic: records sorted by key, schedules in config order, defaults (`enabled: true`, `draft: false`, empty `exclude`) left out, a fixed header comment;
- secrets as placeholders: forge tokens `env('HOLTKEEPER_<FORGE>_TOKEN')`, webhook secrets `env('HOLTKEEPER_<FORGE>_WEBHOOK_SECRET')`, `env()` references of the file config keep their names;
- `server` and `plugins` hold runtime objects and are not exported (the header says so); forges other than GitLab are listed as comments.

`generateWebhookSecret()` returns 32 bytes from `crypto.getRandomValues`, base64url.
