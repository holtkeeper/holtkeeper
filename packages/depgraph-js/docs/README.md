# @holtkeeper/depgraph-js

`GraphSource`s for JavaScript and TypeScript repositories (npm, pnpm, Yarn, Bun). See `@holtkeeper/depgraph` for the model and analyses.

```ts
import { analyzeDependencies } from '@holtkeeper/depgraph'
import { jsSources } from '@holtkeeper/depgraph-js'

const data = await analyzeDependencies({ dir, sources: jsSources() })
```

## Public API

- `jsSources()` — the three sources below.
- `jsWorkspaceSource()` — layer `workspaces`, source `package.json` or `pnpm-workspace.yaml`.
- `jsLockfileSource()` — layer `packages`, source is the lockfile name.
- `jsModuleSource()` — layer `modules`, source `imports`.
- `readJsWorkspaces(dir)`, `findLockfile(dir)`, `lockfiles`, `resolveImport(files, importer, specifier)`, `sourceExtensions`.
- Pure lockfile parsers `parseNpmLock`, `parseBunLock`, `parsePnpmLock`, `parseYarnLock`: `(content, workspaces) => DepGraph`.

Node ids: workspaces use the package name in every layer; packages are `name@version`; source files are paths relative to the repository.

## Workspaces

Patterns come from `workspaces` in the root `package.json` (array or `{ packages }`) and from `pnpm-workspace.yaml`; `!pattern` excludes, `node_modules` is never matched. An edge is added for every `dependencies`, `optionalDependencies`, `peerDependencies` or `devDependencies` entry that names another workspace, whatever the range (`workspace:*`, `^1.0.0`, ...); `npm:` aliases are ignored. When a name is in several fields, `prod` wins, then `optional`, `peer`, `dev`. The root is a node only when it depends on a workspace or there are no workspaces.

## Lockfiles

One lockfile is read. With several present, the one matching `packageManager` in `package.json` wins, otherwise the first of `pnpm-lock.yaml`, `bun.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`.

| File                                       | Versions                                                | Resolution                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `package-lock.json`, `npm-shrinkwrap.json` | lockfile v2, v3                                         | Node's lookup through nested `node_modules`, `link` entries followed to workspaces                                           |
| `bun.lock`                                 | text lockfile (parsed with `Bun.JSONC`)                 | keys are install paths (`finalhandler/debug`), looked up from the innermost scope out; workspaces first under their own name |
| `pnpm-lock.yaml`                           | v9 (`importers` + `snapshots`); v6–8 via `packages`     | `link:` to workspaces; peer variants (`x@1.0.0(peer@2)`) share one node; aliases resolved                                    |
| `yarn.lock`                                | v1 (classic, own parser) and berry (YAML, `__metadata`) | descriptor lookup (`name@range`); classic workspace edges come from `package.json` files                                     |

Yarn berry does not mark dev dependencies, so workspace edge kinds are taken from the workspace's `package.json`; packages' edges are `prod`, `peer`, or `optional` (from `dependenciesMeta`).

## Modules

Scans `src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` of the root and every workspace, skipping `node_modules`, `dist`, `build` and `coverage`, and reads imports with `Bun.Transpiler.scanImports` (type-only imports are not counted; `import`, `export ... from`, dynamic `import()` and `require()` are). Relative specifiers resolve to a scanned file: exact path, the TypeScript source of an emitted extension (`.js` → `.ts`/`.tsx`, `.mjs` → `.mts`, `.cjs` → `.cts`), the path plus an extension, or `index.*`. Bare specifiers that name another workspace (`@fx/b`, `@fx/b/sub`) become an edge to that workspace's node. Each file node carries its `workspace`, so module cycles can be grouped per package.

## Limitations

- `bun.lockb` (binary), `package-lock.json` v1, pnpm lockfiles before v6 and Yarn PnP specifics are not supported.
- tsconfig `paths` aliases, `exports` subpath conditions and imports of files outside `src/` are not resolved.
- Imports of third-party packages are not part of the module layer; the package layer covers them.
- Files that fail to parse are kept as nodes without edges.
