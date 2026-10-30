# @holtkeeper/fleet

Fleet drift across the repositories of one config group: which versions of shared libraries each repository uses, and how far its config files have drifted from golden templates. Everything is read through the forge API (`getRepository`, `readFile`) — nothing is cloned.

## Analyzer

`fleetAnalyzer` (kind `fleet`, scope `group`, needs `forge`) and `createFleetAnalyzer({ registry? })` to inject a `VersionRegistry` factory (called once per run). The record's repo is `{ forge, path: <group> }`.

Options (`fleetOptionsSchema`):

| Option          | Default | Meaning                                                                                                                                                                    |
| --------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libraries`     | `[]`    | Names or globs always tracked: `react`, `@company/*`, `github.com/company/**` (`*` stays within a path segment, `**` crosses them). The flag takes a comma-separated list. |
| `minRepos`      | `3`     | Also track every library used directly by at least this many repositories; `0` disables.                                                                                   |
| `maxWorkspaces` | `20`    | Workspace manifests read per repository besides the root.                                                                                                                  |
| `maxLibraries`  | `100`   | Cap for automatically tracked libraries, most used first.                                                                                                                  |
| `templates`     | `[]`    | Golden files, see below.                                                                                                                                                   |

## What is read per repository

- `package.json`, its `workspaces` (array or `{ packages }`) and `pnpm-workspace.yaml`; `go.mod` plus the modules a `go.work` uses. Glob patterns are expanded with `GitForge.listFiles` when the forge implements it (one listing per pattern, from its literal prefix, `node_modules` ignored); otherwise against the workspace directories the lockfile lists. Literal patterns are read directly. When neither is available, globs are skipped with a note. At most `maxWorkspaces` workspace manifests are read per ecosystem.
- The first lockfile present of `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, for resolved versions of direct dependencies (workspace-specific entries win over hoisted ones).
- `// indirect` Go requirements are kept but do not count towards `minRepos`.
- `workspace:` dependencies and the repository's own packages and modules are ignored.

Each usage's comparable `version` is the resolved version, else the lowest version the declared range admits (`^18.2.0` → `18.2.0`). Archived repositories are listed and skipped; repositories that fail `getRepository` keep an `error`.

Latest versions come from `VersionRegistry.latest(ecosystem, name)`. `createHttpRegistry({ fetch?, npmUrl?, goProxyUrl? })` asks registry.npmjs.org (`dist-tags.latest`) and proxy.golang.org (`/@latest`), caches per instance and answers `undefined` on failures.

## Templates

```ts
{
  path: string // file in each repository
  source?: { repo: 'forge:group/repo'; file?: string; ref?: string } | { content: string }
  mode: 'exact' | 'json-subset' | 'yaml-subset' | 'lines-present' // default exact
  create?: boolean // suggest creating missing files, default true
  lines?: (string | { pattern: string; line?: string; replaces?: string })[] // lines-present only
}
```

A source repository must be on the group's forge; `file` defaults to `path`. A template needs a `source`, except `lines-present` with `lines`.

| Mode            | Matches when                                                                                                     | Suggested fix                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `exact`         | Same text, ignoring CRLF and trailing whitespace at the end                                                      | Replace the whole file                                                                                                  |
| `json-subset`   | Every key the template defines has the same value (JSONC allowed); arrays: every template item matches some item | Replace changed values, append missing keys and items in the file's indentation; comments and trailing commas are kept  |
| `yaml-subset`   | As `json-subset`, for YAML                                                                                       | Same, for block-style YAML; flow collections, block scalars and anchors are reported as `cannot be fixed automatically` |
| `lines-present` | Every non-blank template line is present (trimmed), every `pattern` matches some line                            | Append missing lines; a pattern's `line` replaces the first line matching `replaces`, else is appended                  |

Typical templates:

```ts
templates: [
  {
    path: '.gitlab-ci.yml',
    mode: 'yaml-subset',
    source: { repo: 'work:platform/ci', file: 'templates/node.gitlab-ci.yml' },
  },
  { path: '.nvmrc', mode: 'exact', source: { content: '22\n' } },
  {
    path: 'package.json',
    mode: 'json-subset',
    create: false,
    source: { content: '{"engines":{"node":">=22"}}' },
  },
  {
    path: 'tsconfig.json',
    mode: 'json-subset',
    source: { content: '{"extends":"@company/tsconfig/base.json"}' },
  },
  { path: '.oxlintrc.json', mode: 'exact', source: { repo: 'work:platform/configs' } },
  {
    path: 'Dockerfile',
    mode: 'lines-present',
    create: false,
    lines: [{ pattern: '^FROM node:22', line: 'FROM node:22-alpine', replaces: '^FROM node:' }],
  },
]
```

Each result becomes a `CodeChange` with `target` set to the repository (`confidence: 'review'`, `source: 'fleet'`, id stable for the same edits), so accepting fixes opens one merge request per repository.

## Data

```ts
interface FleetData {
  group: string
  repos: { path; webUrl?; manifests: string[]; error?; archived? }[]
  libraries: {
    ecosystem: 'npm' | 'Go'
    name
    latest?
    reason: 'option' | 'auto'
    usages: LibraryUsage[]
  }[]
  templates: {
    repo
    file
    mode
    status: 'identical' | 'drifted' | 'missing' | 'error'
    problems: string[]
    change?
  }[]
  notes: { repo?; message }[]
}
interface LibraryUsage {
  repo
  manifest
  declared
  resolved?
  version?
  kind: 'prod' | 'dev' | 'peer' | 'optional' | 'indirect'
}
```

`fleetDataSchema` validates it. Pure helpers: `summarizeLibrary` (cells per repository with the oldest version and its lag, versions and majors in use, repositories on the oldest major and behind a major), `fleetTotals`, `subsetDifferences`, `compareWithTemplate`, `jsonSplices`, `yamlSplices`, the manifest and lockfile parsers and `lagOf`/`minimumOfRange`.

## Report

`fleetAnalysis` (kind `fleet`).

- Metrics with deltas: repositories, tracked libraries, libraries with several majors, repositories behind a major, drifted and missing config files.
- **Versions**: matrix of repositories × libraries (oldest version, tone by lag: latest good, patch neutral, minor warning, major bad), stacked chart of the spread per library.
- **Libraries**: latest, versions in use, repositories, those on the oldest major, behind a major (with delta); issues for libraries that gained or lost a major since the previous record.
- **Config drift**: status table repositories × templates, differences as issues (`new` / `resolved` against the previous record), applicable `changes` block.
- **Notes**: unreadable or archived repositories, read problems, libraries whose latest version is unknown.

## Limitations

- Lockfile readers only resolve direct dependencies; `bun.lockb` (binary) and Yarn lockfiles are not read.
- Without `listFiles`, workspace globs need a lockfile; at most `maxWorkspaces` workspace manifests are read.
- Subset modes do not remove keys or items, and YAML edits only cover block-style documents.
