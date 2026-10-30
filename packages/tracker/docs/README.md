# @holtkeeper/tracker

Declarative tracking of entities across repositories and documents. A tracker says what an entity is (a feature flag, an environment variable, a metric name, ...), where it appears, what is wrong with it and where an overview should be kept. Feature flags are just one configuration; nothing in the package knows about them.

Repositories are read through `GitForge.readFile` / `listFiles` — nothing is cloned. Documents are read through an injected `DocumentSource` and written through an injected `DocumentSink` (implemented by `@holtkeeper/confluence`). Analysis never writes: it plans publications and code changes; publishing is a separate step.

## Model

```
sources ──extract──▶ hits (raw key, line, attrs) ──normalize──▶ entities ──rules──▶ findings
                                                                    │
                                                         outputs ───┴──▶ publications (documents, notifications)
                                                                    └──▶ changes (repository files → merge requests)
```

- **Entity** — `{ key, labels, attrs, environments, occurrences }`. `key` is the normalized key, `labels` every spelling found (`FEATURE_NEW_LOBBY`, `newHub`). `attrs` merges attributes of occurrences without an environment; the value from the best-ranked role wins (`definition` > `documentation` > `config` > `usage` > others, then source order), each with its provenance (`from`), and `values` lists every distinct value when sources disagree. `environments` holds attributes per environment (e.g. Helm values per `values-<env>.yaml`).
- **Occurrence** — one place: `{ source, role, repo?, file?, line?, document?, environment?, raw?, attrs }`.
- **Role** — what a source says about an entity: `definition`, `usage`, `config`, `documentation` or any custom string. Rules are configured in terms of roles.
- **Finding** — `{ id, rule, ruleId, severity, key, message, environment?, occurrences }`; `id` (`<ruleId>:<key>[:<env>]`) is stable across runs, so reports show new and resolved findings.

## Definition

`trackerDefinitionSchema` (zod) validates a definition and applies defaults; `trackersSchema` validates a list with unique ids. The list is the scoped setting `trackers` (`trackersSetting`, shaped like a `SettingDefinition` for the settings registry, with `help` and a `form` marked `x-editor: trackers` for the panel's block editor) and the config entry of the same name. Fields that name roles carry JSON Schema metadata: a source's `role` is `x-role: provides`, every rule field listing the roles it compares (`definition`, `usage`, `config`, `documentation`, `roles`, `role`, `against.role`) is `x-role: reads`, so editors can draw which sources feed which rules without knowing rule kinds.

```ts
{
  id: 'feature-flags',
  name: 'Feature flags',
  entity: { label: 'Feature flag', key: { normalize: ['trim-prefix:FEATURE_', 'snake'] } },
  sources: Source[],
  rules?: Rule[],     // default []
  outputs?: Output[], // default []
}
```

Key normalization steps apply in order after trimming: `lower`, `upper`, `snake` (`new_hub`), `kebab` (`new-hub`), `camel` (`newHub`), `trim-prefix:<p>` and `trim-suffix:<s>` (case-insensitive). Word splitting understands camelCase, snake_case, kebab-case and acronyms.

Sources and outputs get ids `<kind>-<n>` (1-based) unless they set `id`; rules default to their kind. Ids must be unique within a tracker.

### Sources

| Kind       | Config                                                                                                                                                             | Reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`    | `role`, `paths` (globs), `repos?` (paths or globs), `groups?`, `exclude?`, `ref?`, `extract`, `environment?`, `maxFiles` 200, `maxBytes` 5 MB, `maxFileBytes` 1 MB | Without `repos`/`groups`: every repository of the analyzed group. Globs in `repos` match the group's repositories (or those of `groups`); literal paths are read even outside the group (e.g. `infra/helm`). A literal file path is read directly; a glob is expanded with one recursive `listFiles` per literal directory. Caps are per repository; files over them are skipped with an error. `environment` is fixed, or `{ fromPath: <regex> }` with group `env` (or group 1) on the file path. |
| `document` | `role`, `provider`, `ref`, `extract`, `environment?`                                                                                                               | One page through `documents[provider].read(ref)`. Its version is remembered so outputs writing to the same page expect it.                                                                                                                                                                                                                                                                                                                                                                         |

File extractors (`extract` of `files`):

| Kind        | Config                                                                                  | Yields                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `json-path` | `path`, `select?` (`key`/`value`), `key?`, `attrs?`                                     | Nodes selected by a JSONPath subset (`$`, `.name`, `['name']`, `.*`, `[*]`, `[0]`) from JSON/JSONC. Members of `.*` give their name as key (a scalar member value becomes attribute `value`); other nodes give their scalar value. `key` (`$.name`) and `attrs` (`{ default: '$.default' }`) are paths relative to the node. Lines are located by searching the key. |
| `yaml-path` | as `json-path`                                                                          | The same for YAML (first document of multi-document files).                                                                                                                                                                                                                                                                                                          |
| `regex`     | `pattern`, `flags?`                                                                     | Every match; group `key` (else group 1, else the match) is the key, other named groups are attributes, with line numbers.                                                                                                                                                                                                                                            |
| `env`       | `keys?` (glob, e.g. `FEATURE_*`)                                                        | `NAME=value` and `export NAME=value` lines; the unquoted value is attribute `value`.                                                                                                                                                                                                                                                                                 |
| `ast-grep`  | `pattern`, `language?`, `capture?` (default `KEY`), `attrs?` (attribute → metavariable) | Code matches of an ast-grep pattern such as `isEnabled($KEY)` or `flags.$KEY`; string literal quotes are stripped. Language from the extension (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `html`, `css`) or `language`. Note that `isEnabled('$KEY')` matches only single-quoted calls; prefer `isEnabled($KEY)`.                                                      |
| `lines`     | `pattern?`, `comment?` (default `#`)                                                    | One key per non-empty line, or per line matching `pattern` (groups as for `regex`).                                                                                                                                                                                                                                                                                  |

Document extractors (`extract` of `document`):

| Kind    | Config                              | Yields                                                                                                                                                                                                                                                                                                                      |
| ------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `table` | `keyColumn`, `heading?`, `columns?` | Rows of every table that has `keyColumn` (case-insensitive), optionally only under a heading containing `heading`. `columns` maps attribute → column header; default every other column, named by its lowercased header. Storage/HTML bodies are parsed with `parseHtmlTables`, Markdown bodies with `parseMarkdownTables`. |
| `list`  | `heading?`, `pattern?`              | List items; the key is the first code span, else the text before `-`, `: ` or `—` (the rest becomes `description`), or what `pattern` captures.                                                                                                                                                                             |

`parseHtmlTables(html)` returns `{ heading?, headers, rows }[]`: the header row is the `<thead>` row, else the first row of `<th>` cells, else the first row; `colspan` repeats cells; entities and CDATA are decoded, whitespace collapsed, Confluence user mentions become `@<account id>` and page links their title. It never throws on malformed markup.

### Rules

Every rule takes `id?`, `severity?` (`info`/`warning`/`error`) and `ignore?` (key globs). Rules are pure functions of the entities.

| Kind                 | Finds                                                                 | Options (defaults)                                                                                                       | Severity |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| `unused`             | Definitions without usages                                            | `definition` `['definition']`, `usage` `['usage']`                                                                       | warning  |
| `undefined`          | Usages, config or docs of keys without a definition                   | `definition`, `roles` `['usage','config','documentation']` — narrow it when `stale-config`/`documented-missing` also run | error    |
| `stale-config`       | Config entries whose key has no definition                            | `definition`, `config` `['config']`                                                                                      | warning  |
| `undocumented`       | Definitions the documentation does not mention                        | `definition`, `documentation` `['documentation']`                                                                        | info     |
| `documented-missing` | Documentation entries without a definition                            | `definition`, `documentation`                                                                                            | warning  |
| `attribute-mismatch` | An attribute differing between two roles, one finding per environment | `attr`, `role` `definition`, `against: { role: 'config', attr: <attr> }`, `environments?`                                | warning  |
| `naming`             | Spellings not matching a regular expression                           | `pattern`, `on` `raw` (or `key`), `roles` `['definition']`                                                               | warning  |

`attribute-mismatch` compares loosely: case, surrounding whitespace, number spelling and boolean words (`on`/`yes`/`1`/`enabled` vs `true`) are ignored.

### Outputs

Outputs render entities through a **template**: `{ title?, intro?, columns?: { header, value }[], groupBy?, sort? (field or { by, order }), roles?, findings? }`. Field values: `key`, `label`, `labels`, `roles`, `definedIn`, `usedIn` (repositories with usages), `usages` (count), `documented`, `environments`, `env:<name>` / `env:<name>.<attr>`, `role:<role>` (places), `findings` (rule ids), any other name is an attribute. Default columns: Key, Description, Defined in, Used in, Environments, Documented. Rendering is deterministic (no timestamps), so unchanged data means unchanged content.

| Kind               | Config                                                                                                   | Plans                                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document-section` | `provider`, `ref`, `markerId?`, `format` (`storage` default, `html`, `markdown`), `message?`, `template` | A publication `{ provider, ref, markerId, format, content, expectedVersion? }`. Without `markerId` the publication carries `markerId: ''`, meaning the whole page. `expectedVersion` is set when a `document` source read the same page in this run. |
| `repo-file`        | `repo`, `path`, `format?` (from the extension: `json` or `markdown`), `ref?`, `title?`, `template`       | A `CodeChange` with `target: { forge, path: repo }` creating or replacing the whole file, or nothing when the file is current. Accepting it opens a merge request like any other change.                                                             |
| `notify`           | `title?`, `maxFindings` 10, `onlyWhenFindings` false                                                     | A `text` publication without provider: a summary for notification channels.                                                                                                                                                                          |

## Contracts

Implemented by provider packages (e.g. `@holtkeeper/confluence`):

```ts
interface DocumentSource {
  readonly provider: string
  read(ref: string): Promise<{
    ref
    title
    version: number
    url
    format: 'storage' | 'markdown' | 'html'
    body: string
  }>
}
interface DocumentSink {
  readonly provider: string
  replaceSection(
    ref: string,
    input: {
      markerId: string
      content: string
      format: 'storage' | 'markdown' | 'html'
      expectedVersion?: number
      message?: string
    },
  ): Promise<{ version: number; url: string; changed: boolean }>
}
```

A sink must reject when `expectedVersion` no longer matches; `isVersionConflict(error)` recognizes `DocumentVersionConflictError` (exported), any error with `code` `version_conflict`/`conflict`, or `status` 409. An empty `markerId` replaces the whole body.

## Engine and publishing

- `runTracker(definition, { forge, forgeId?, repos, group?, groupRepos?, documents, sinkProviders?, now, concurrency?, log? }) → TrackerData` — `{ tracker, generatedAt, entities, findings, sourcesRead, errors, publications, changes }`. Invalid definitions throw; read, extraction, provider and output problems end up in `errors` and the run continues.
- `publishTracker(data, { sinks, outputs? }) → { outcomes, published, conflicts, failed }` executes document publications one by one. Statuses: `published`, `unchanged`, `conflict` (the page changed since the analysis; nothing written — re-run the tracker), `skipped` (no sink for the provider), `failed`. Notifications are left to their consumers.

## Analyzer and report

`createTrackerAnalyzer({ documentsFor?, sinksFor?, definitionsFor?, groupRepos?, now? })` (kind `tracker`, scope `group`, needs `forge`); `trackerAnalyzer` has no document providers. Options (`trackerOptionsSchema`): `{ tracker: <id> }` looked up in `definitionsFor(repo)` (settings + config), or `{ definition: <inline> }`; flag `--tracker`. `sinksFor` is only used to report outputs nobody could publish.

`trackerAnalysis` (kind `tracker`) validates data with `trackerDataSchema`, exposes `changes(data)`, and reports:

- **Metrics** — entities, findings (and per rule), sources read, read errors; deltas against the previous record of the same tracker (records of other trackers on the same group are ignored).
- **Entities** — key, label/description, defined in, used in, environments with values, documented, findings; new keys highlighted, removed keys listed.
- **Findings** — issues grouped by rule, worst first, tagged `new`; resolved findings.
- **Matrix** — key × repository (roles with counts) and key × environment (value).
- **Publications** — a preview of every planned publication and the publish hint.
- **Changes** — `repo-file` changes, applicable.
- **Errors**.

The server publishes with `POST /api/trackers/:analysisId/publish` (body `{ outputs?: string[] }`, permission `analyses:run` on the record's group), using `documentSinks(repo)` from the server dependencies (503 without them), and records a `tracker.published` activity event and a `tracker.publish` audit event.

## Example: feature flags

Game repositories `games/*` define flags in `src/flags.json` (`{ "flags": [{ "name", "default", "description" }] }`) and use them as `isEnabled('…')`; the Helm repository `infra/helm` sets them per environment in `charts/*/values-{env}.yaml` under `featureFlags`; a Confluence page documents them in a Flag/Description/Owner table. The tracker keeps a generated inventory between the `holtkeeper:flags` markers on that page and in `docs/flags.md` of the Helm repository.

```ts
trackers: [
  {
    id: 'feature-flags',
    name: 'Feature flags',
    entity: { label: 'Feature flag', key: { normalize: ['snake'] } },
    sources: [
      {
        kind: 'files',
        id: 'definitions',
        role: 'definition',
        repos: ['games/*'],
        paths: ['src/flags.json'],
        extract: {
          kind: 'json-path',
          path: '$.flags[*]',
          key: '$.name',
          attrs: { default: '$.default', description: '$.description' },
        },
      },
      {
        kind: 'files',
        id: 'usages',
        role: 'usage',
        repos: ['games/*'],
        paths: ['src/**/*.{ts,tsx}'],
        extract: { kind: 'ast-grep', pattern: 'isEnabled($KEY)' },
      },
      {
        kind: 'files',
        id: 'helm',
        role: 'config',
        repos: ['infra/helm'],
        paths: ['charts/*/values-*.yaml'],
        extract: { kind: 'yaml-path', path: '$.featureFlags.*' },
        environment: { fromPath: 'values-(?<env>[a-z]+)\\.yaml$' },
      },
      {
        kind: 'document',
        id: 'wiki',
        role: 'documentation',
        provider: 'confluence',
        ref: '12345',
        // Only the hand-written table: the generated section has its own heading.
        extract: {
          kind: 'table',
          heading: 'Flags',
          keyColumn: 'Flag',
          columns: { description: 'Description', owner: 'Owner' },
        },
      },
    ],
    rules: [
      { kind: 'unused' },
      { kind: 'undefined', roles: ['usage'] },
      { kind: 'stale-config' },
      { kind: 'undocumented' },
      { kind: 'documented-missing' },
      {
        kind: 'attribute-mismatch',
        attr: 'default',
        against: { role: 'config', attr: 'value' },
        environments: ['prod'],
      },
      { kind: 'naming', pattern: '^[a-z][a-z0-9_]*$' },
    ],
    outputs: [
      {
        kind: 'document-section',
        id: 'wiki-section',
        provider: 'confluence',
        ref: '12345',
        markerId: 'holtkeeper:flags',
        template: {
          title: 'Flag inventory',
          columns: [
            { header: 'Flag', value: 'key' },
            { header: 'Description', value: 'description' },
            { header: 'Owner', value: 'owner' },
            { header: 'Repositories', value: 'usedIn' },
            { header: 'prod', value: 'env:prod' },
          ],
        },
      },
      {
        kind: 'repo-file',
        id: 'helm-doc',
        repo: 'infra/helm',
        path: 'docs/flags.md',
        template: { title: 'Feature flags', findings: true },
      },
      { kind: 'notify', id: 'chat', onlyWhenFindings: true },
    ],
  },
]
```

Run the `tracker` analyzer on the group with option `tracker: 'feature-flags'` (or `--tracker feature-flags`). When a tracker both reads and writes the same page, keep the generated section distinguishable (its own heading, or other column headers), otherwise the next run reads the generated table back as documentation.

## Adding a provider

Every kind is one file exporting an object with `kind`, a zod `schema` whose `kind` is a literal, and its function; the registry next to it lists it in the discriminated union and the lookup map:

| Kind of provider   | Interface (file)                               | Function                                                   | Registry                  |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------- | ------------------------- |
| File extractor     | `Extractor` (`src/extractors/types.ts`)        | `extract(text, config, { file }) → Extracted[]`            | `src/extractors/index.ts` |
| Document extractor | `DocumentExtractor` (`src/documents/types.ts`) | `extract(document, config) → Extracted[]`                  | `src/documents/index.ts`  |
| Source             | `SourceProvider` (`src/sources/types.ts`)      | `read(config, context) → SourceResult`                     | `src/sources/index.ts`    |
| Rule               | `Rule` (`src/rules/types.ts`)                  | `evaluate(entities, config, { label }) → RuleHit[]` (pure) | `src/rules/index.ts`      |
| Output             | `OutputProvider` (`src/outputs/types.ts`)      | `plan(config, context) → OutputResult` (no writes)         | `src/outputs/index.ts`    |

1. Add `src/<area>/<kind>.ts` with the schema (`z.object({ kind: z.literal('<kind>'), ... })`) and the provider, typed with `satisfies <Interface><z.output<typeof schema>>`.
2. Add its schema to the `z.discriminatedUnion` and the provider to the map in the area's `index.ts`.
3. Add tests next to it and a row to the tables above.

Extractors and rules must be pure and may throw on bad input (the engine records it); sources and outputs must not throw and report problems in `errors`. A new document provider (Notion, a wiki) needs no change here: implement `DocumentSource`/`DocumentSink` in its own package and pass them by provider name.

## Limitations

- JSONPath is a subset: no recursive descent (`..`), filters or slices.
- Line numbers of `json-path`/`yaml-path` are found by searching the key text and may point at the first of several equal keys.
- `ast-grep` supports the languages built into `@ast-grep/napi` (TypeScript, TSX, JavaScript, HTML, CSS).
- Glob sources need `GitForge.listFiles`; without it only literal paths are read.
