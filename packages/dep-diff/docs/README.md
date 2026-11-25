# @holtkeeper/dep-diff

Dependency changes between two sides of a repository (two commits, tags or branches), npm and Go, direct and transitive. It works from the list of changed files and a reader for a file at either side, so it needs no checkout: the server feeds it `GitForge.compareCommits` and `GitForge.readFile`. Pure apart from that reader.

```ts
import { diffDependencies, renderDependencyDiff } from '@holtkeeper/dep-diff'

const diff = await diffDependencies({
  files: await forge.compareCommits(repo, fromSha, toSha),
  read: (path, side) => forge.readFile(repo, path, side === 'from' ? fromSha : toSha),
})
renderDependencyDiff(diff) // compact Markdown for prompts and tool answers, '' without roots
```

## Public API

| Export                                                                                                                                                      | What it guarantees                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `diffDependencies(input)`                                                                                                                                   | A `DependencyDiff`; never throws, deterministic order, each file read at most once per side                           |
| `renderDependencyDiff(diff, options?)`                                                                                                                      | Markdown: one `###` block per root, counts, direct changes (`maxDirect`, 30), transitive sample (`maxTransitive`, 20) |
| `emptyDependencyDiff()`                                                                                                                                     | `{ roots: [], skipped: 0, partial: false }`                                                                           |
| `DependencyFilesReader`                                                                                                                                     | `files` (changed files with `oldPath`, `newPath`, `status`) and `read(path, side)`, `undefined` when missing          |
| `DependencyDiff`, `DependencyRoot`, `DirectDependencyChange`, `TransitiveDependencyChange`, `DependencySide`, `DependencyEcosystem`, `DependencyChangeKind` | The result types                                                                                                      |

`diffDependencies` also takes `maxRoots` (default 20; the rest are counted in `skipped`) and `partial` (passed through to the result, for when the caller's file list was cut by the forge).

## How roots are found

- A root is a lockfile root (npm) or a Go module directory whose `package.json`, supported lockfile (`pnpm-lock.yaml`, `bun.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`), `go.mod` or `go.sum` changed. Paths under `node_modules/`, `vendor/` and `testdata/` are skipped.
- A changed `package.json` belongs to the nearest directory upward that has a supported lockfile at either side (found with `read`). Without one, its own directory is the root and changes carry ranges only.
- When several lockfiles sit in one root, the one matching `packageManager` wins, then one present at `to`, then the `lockfiles` order of `@holtkeeper/depgraph-js`.
- Roots with no change and no error (a `package.json` edit outside its dependencies) are left out.

## What a root reports

- **npm direct** — per workspace (path relative to the root, `.` for the root) and field (`prod`, `dev`, `optional`, `peer`): dependencies added, removed, or `updated` when the range or the resolved version changed. Versions come from the lockfile at each side. When the lockfile changed, every importer it lists is compared, so a re-resolution with an unchanged `package.json` is reported too (its field read from that `package.json`). Workspace links (`workspace:` ranges or resolutions) are left out.
- **Go direct** — `go.mod` requirements added, removed or at another version; `field` is `require` or `indirect`, `workspace` the module path, the version in `version` (no `range`). `replace` directives are not applied.
- **Transitive** — packages of the whole lockfile (or module paths of `go.sum`) whose version set changed, without names that are direct dependencies anywhere in the root. Cut at 500 entries with `transitiveCapped`; `counts` count all of them. Not computed when a lockfile did not parse at one side.
- **Errors** — failed reads and unparseable manifests or lockfiles, as sentences; the root still reports what could be computed. Yarn classic lockfiles list no importers, so only the root and the changed `package.json` files are seen.
