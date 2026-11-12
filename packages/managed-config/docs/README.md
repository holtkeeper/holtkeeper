# @holtkeeper/managed-config

Forges, groups, repository traits, schedules and triggers edited in the panel. They are typed documents in `store.config` (`ConfigStore` from `@holtkeeper/store`); `holtkeeper.config.ts` holds only infrastructure. This package turns the file config plus those documents into the config the server runs on and keeps it current.

## Documents

| Type         | Id                                                                              | Data                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `forge`      | forge id (`work`)                                                               | `{ kind: 'gitlab' \| 'github', url, credentialId, packages?, cachePackages?, botUsername?, webhook?, sshKey? }`                  |
| `group`      | group id (`groupIdSchema`: `shapes`, or `shapes.round` for a subgroup)          | `{ title? (display, 1–60 chars), forge, include[], exclude[] }`                                                                  |
| `repoTraits` | free; merged by `pattern`                                                       | `{ pattern, forge?, traits }`                                                                                                    |
| `schedule`   | the schedule's config `name`                                                    | `{ name (display), enabled, analyzers, groups?, repos?, options?, cron \| every, timezone?, windows?, jitterMinutes?, spread? }` |
| `trigger`    | `tag`, `push`, `merge-request`, `label:<label>`, `command:<name>` (`triggerId`) | `{ on: 'tag' \| 'push' \| 'mergeRequest' \| 'label' \| 'command', ... }` as the matching `jobs` entry                            |

Every document has `version` (1, 2, …), `updatedAt`, `updatedBy`; earlier versions stay in `history(type, id)` until the document is removed. Body schemas for the panel's endpoints are in `documentDataSchemas` (ids, cron checked with croner, `every` like `15m`/`1h`/`1d`, IANA zones, `HH:MM` windows). A forge's token is never in a document: `credentialId` points at a stored credential.

## Effective config

`effectiveConfig(file, documents, { forgeFactories, tokens?, webhookSecrets?, reuse? })`:

- Forges, groups, repository traits (by `pattern`), schedules and triggers come only from documents: triggers become `onTag`, `onPush`, `onMergeRequest`, `onNewRepo`, `onLabel[label]` and `commands[name]` of `jobs`. The file config contributes its infrastructure (`server`, `jobs` worker settings, `limits`, `ai`, `dryRun`).
- Forges are built by `forgeFactories[kind](doc, token)` with the credential's plaintext token from `tokens`. A missing token or adapter gives a forge whose `create()` throws, so only tasks using it fail.
- A forge's `botUsername` becomes `jobs.botUsernames.<id>`: the server ignores that account's own events on the forge and review skips its merge requests.
- A forge with a webhook secret (opened, in `webhookSecrets`) becomes `jobs.webhooks.<id>.secret`.
- The result always has a `jobs` section and is validated with `parseConfig`; an unknown forge or group reference or a duplicate schedule throws `ConfigError`.

`gitlabForgeFactory({ fetchFor? })` is the GitLab factory (`gitlab({ url, token, fetch })`).

## Result

`EffectiveConfig` holds the built `config` and `forges`: each forge's `kind`, `url` and `credentialId`.

## ConfigSource

```ts
const source = await createConfigSource({
  file, // parseConfigFile result
  store: store.config, // optional: without it there are no forges, groups or triggers
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

`seedDefaults({ store, analyzers })` writes each of `defaultTriggers` as a panel document the first time a store sees it, so a release that adds defaults adds them to existing installs too. Each document is considered once (marker `defaultMarker(id)` = `config:default-seeded:trigger:<id>` in `Store.kv`, taken atomically when the store supports `compareAndSet`): removing it later does not bring it back, and a panel document with the same id stays as it is. Analyzers the server lacks are dropped. Audited as `config.seed` by the system actor.

No schedule is seeded: analyses stay current through freshness (the `refresh` each analyzer declares, run by the server's sweeper, see [the server docs](../../../apps/server/docs/README.md#freshness)). Schedules people create in the panel still run.

`retireSeededSchedules({ store })` deletes the schedule documents earlier releases seeded (`retiredScheduleIds`: `ci-jobs-nightly`, `renovate-nightly`, `guide-weekly` and the `*-weekly` ones), so an upgraded install does not run them next to freshness. Only documents still last written by the system (`updatedBy: 'system'`) go; a seeded schedule a person edited stays. It runs once per store (marker `config:retired-seeded-schedules` in `Store.kv`, written after the deletes, so a start cut short tries again; deleting by id is idempotent, so pods starting together do no harm): a schedule created later under one of those ids stays. The server calls it at startup, before `seedDefaults`. Audited as `config.retire-schedules` by the system actor when it removed anything.

The default trigger `tag` queues `api-surface` for every new or moved tag, from webhooks or polling. The default trigger `new-repo` (`{ on: 'newRepo' }`) runs every analyzer that only reads (the Guide generator `guide` included, hash-gated), once, on the default branch, for each repository a group listing finds for the first time. `defaultTriggerAdditions` bring analyzers added to a default trigger later to installs that already have it: each addition appends its missing analyzers to the existing document once (marker `config:default-seeded:trigger:<id>`, e.g. `tag+api-surface`), so taking one out again in the panel sticks.

## Webhook secrets

`generateWebhookSecret()` returns 32 bytes from `crypto.getRandomValues`, base64url.
