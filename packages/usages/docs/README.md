# @holtkeeper/usages

The `usages` analyzer and analysis kind: which packages a repository's code imports, at which versions, and which of their exports, members and JSX props it uses where, with a snippet of each use. The server joins the newest record of every repository into a fleet-wide index: "used by" for a package, the code behind each use, and the uses an upgrade breaks — for people in the web UI and for agents over MCP when they plan migrations.

## Public API

- `usagesAnalyzer` — `Analyzer<UsagesData, UsagesOptions>`, kind `usages`, scope `repo`, needs `checkout`. Options (`usagesOptionsSchema`; lists also accept a comma-separated string, as the flags pass them):
  - `packages: string[]` (`--packages`) — glob patterns of package names to keep, e.g. `@acme/*`; every imported dependency when empty.
  - `exclude: string[]` (`--exclude`) — glob patterns of files to skip, e.g. `**/*.stories.tsx`.
  - `types: 'auto' | 'off'` (`--types`) — resolve names with the TypeScript checker when a `tsconfig.json` and installed dependencies exist (default `auto`).
  - `install: boolean` — install dependencies from the lockfile first, without lifecycle scripts, so the checker sees them (default `true`; skipped when `node_modules` exists or `types` is `off`). Uses `installDependencies` of `@holtkeeper/coverage`.
- `usagesAnalysis` — the `AnalysisKind` (`schema: usagesDataSchema`, `summarize`, `toReport`); `usagesReport(data, options)` builds the report directly. Metrics: packages used, exports used, uses, files read and, when the checker ran, uses found by types. Sections: packages (versions, workspaces, counts, most used exports), most used exports of third-party packages with props, members and a snippet, how uses were found (checker status, unreadable files).
- `extractUsages({ dir, packages?, exclude?, types?, signal?, log? }): Promise<UsagesData>` — the extraction itself; installs and builds nothing.
- `scanFile(file, code, known)` → `FileScan { sites, candidates, problem? }` — the syntactic pass over one file; `parseSpecifier(specifier)` splits a bare import into package and entry point.
- `resolveTypes({ dir, workspaces, files, known, signal? })` → `TypesOutcome` — the type checker pass; `packageOfPath(path, workspaces)` maps a declaration file to its package.
- Fleet views, all pure and generic over how a repository is identified (`UsageEntry<Origin> { origin, data }`):
  - `packageUsage(entries, name)` → `PackageUsage { name, versions, repos, exports }` — repositories using the package with versions and counts, and each export summed over them with kinds, members and props.
  - `findSites(entries, { package, export?, member?, prop?, kind?, origins?, limit? })` → `{ sites, total, more }` — kept sites with snippets. `member` matches a path or a run of its segments (`reset` finds `().reset`).
  - `upgradeImpact({ entries, package, changes, declarations? })` → `UpgradeImpact { items, affected, unaffected }` — see below. `changes` are `UpgradeChange`s, which `PackageDiff.changes` of `@holtkeeper/api-surface` satisfy.
  - `repoPackages(data)` — the packages of one record with versions and counts.
  - `usedByCounts(entries, names)` → `Map<name, UsedByCount { repos, count, files }>` — totals per package without the per-export breakdown; unused names map to zeros.
  - `declaredMembers(signature)` — top-level member names of a declaration.
- Markdown for agents: `renderPackageUsage(usage, { originLabel })`, `renderSites(found, originLabel?)`, `renderImpact(impact, originLabel?)`, `renderSite(site, label?)`.
- Model: `UsagesData { packages, files, types, problems? }`, `UsedPackage { name, versions, ranges, workspaces, local?, count, files, exports }`, `UsedExport { name, subpath, count, files, kinds, members, props, spread, sites, truncated? }`, `UsageSite { file, line, column, kind, member?, props?, spread?, typed?, snippet, snippetLine }`, `TypeResolution { status, reason?, projects?, sites? }`, `UsageKind`, `usageKinds`, `isUsageKind(value)`, `importPath(name, subpath)`, `usageLimits`.

## How uses are found

1. **Files** — every `ts`, `tsx`, `mts`, `cts`, `js`, `jsx`, `mjs`, `cjs` file of the checkout except declaration files and anything under `node_modules`, `.git`, `dist`, `build`, `out`, `coverage` and framework caches; at most 20 000. Each file belongs to the deepest workspace (`package.json` workspaces or `pnpm-workspace.yaml`) containing it.
2. **Packages** — a bare import counts when some workspace declares the package in its dependencies (any field) or the package is one of the workspaces; a workspace importing itself does not count. Relative paths, Node built-ins, URLs, `#` imports and `@/` / `~/` aliases are never packages.
3. **Imports** (oxc parser, no type information) — named, aliased, default and namespace imports, `require()` and `import()` with or without destructuring, `const { a } = ns`, `export … from` and side-effect imports. Each reference to an imported name becomes a site with its kind: `call`, `new`, `jsx`, `member`, `type` (type references and `typeof`), `extends` (also `implements` and interface heritage), `reexport`, `reference`; names never referenced become `import` sites. Member chains are followed up to four segments with `()` for call results (`useStore().level.up`), destructuring of an export or its call result lists one site per property, a namespace's first member names the export, and JSX sites carry the attribute names, `children` when the element has any, and whether props were spread. Shadowing of an imported name by a local one is not tracked.
4. **Types** (optional) — names the imports do not explain (locals, member reads on values of unknown origin, JSX tags and type names without an import) go to the TypeScript 7 checker through its API (`typescript/unstable/async`, which spawns `tsgo` and talks to it over stdio; the sync API needs Node's file descriptors and does not run on Bun). Every `tsconfig*.json` at the root and in each workspace is opened; files outside all projects are skipped. A name counts when its declaration (after following aliases) lies in `node_modules/<package>` (`@types/x` counts as `x`; TypeScript's default libraries never count) or in another workspace, and the package is a declared dependency. The export is the outermost named declaration around it and the member the rest: `store.reset()` with `store = useStore()` is `Store` → `reset`, a component imported through a local barrel or a `paths` alias is the package's component with its props. Members of type literals the package never names go under the export `(anonymous)`. Sites found this way are `typed` and use subpath `.`. Offsets are UTF-16 in both parsers, so non-ASCII text before a use does not shift it. The checker needs installed dependencies and reports `skipped` without them or without a `tsconfig.json`, `failed` with the error when it cannot start or answer; uses from imports are kept either way.
5. **Versions** — from the lockfile through `@holtkeeper/depgraph-js` for the workspaces importing the package (all workspaces when those resolve none), highest first; `ranges` are what the importing workspaces declare.
6. **Caps** — 20 sites with a snippet per export (two lines around the use, common indentation removed, lines cut at 200 characters), 100 members and props per export, 50 problems. Counts always cover every use.

## Upgrade impact

`upgradeImpact` joins an API diff with the uses of every repository, matching by export name:

- a **removed** export is `breaking` wherever it is used;
- a **changed** declaration is `breaking` where a use touches a member or prop the new declaration no longer lists (`declaredMembers` of `before` minus those of `after`) — through the export itself or through any export whose old declaration mentions it, e.g. props passed to `Button` for a changed `ButtonProps`; other uses of it are `check`;
- a **deprecated** export is `deprecated` wherever used; added exports are ignored.

Items are sorted by level, then by uses; each lists the repositories with their versions, the export the uses go through (`via`), the members touched and up to ten sites. Which repositories still need the upgrade is the caller's choice; the server leaves out those already on the target version.

## Limitations

- JavaScript and TypeScript only; other ecosystems need their own scanner.
- Records keep a sample of sites per export; `findSites` returns kept sites only, `total` counts all uses where the query does not narrow below an export.
- Without the checker, uses through local wrappers, re-exporting barrels, `paths` aliases or values a package returned are invisible; with it, uses typed as `any` still are.
- Member-level impact reads declarations as text: members declared one per line inside the outer braces are found, mapped or computed types are not.
