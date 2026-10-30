# @holtkeeper/api-surface

The `api-surface` analyzer and analysis kind: reads the public API of every package in a checkout (each entry point, every exported name with its declaration and doc comment) so agents and people can look it up without reading the sources. Run on release tags it keeps one record per version; the server serves the records to agents over MCP and diffs them between versions. Purely syntactic (oxc parser): nothing is installed, built or type-checked, and it works on TypeScript sources and published declaration files alike.

## Public API

- `apiSurfaceAnalyzer` — `Analyzer<ApiSurfaceData, ApiSurfaceOptions>`, kind `api-surface`, scope `repo`, needs `checkout`. Options (`apiSurfaceOptionsSchema`; lists also accept a comma-separated string, as the flags pass them):
  - `packages: string[]` (`--packages`) — glob patterns of package names to keep, e.g. `@acme/*`; every package when empty.
  - `exclude: string[]` (`--exclude`) — glob patterns of package folders to skip, e.g. `examples/*`.
  - `includePrivate: boolean` — include packages with `"private": true` (default `true`: workspace packages of a monorepo are often private yet imported by its apps).
- `apiSurfaceAnalysis` — the `AnalysisKind` (`schema: apiSurfaceDataSchema`, `summarize`, `toReport`); `apiSurfaceReport(data, options)` builds the report directly. Metrics: packages, exports, documented share (`better: 'up'`), deprecated and, against the previous record, removed exports. Sections: packages, changes since the previous record (with semver warnings), undocumented exports, unreadable files.
- `extractApi({ dir, packages?, exclude?, includePrivate? }): Promise<ApiPackage[]>` — the extraction itself.
- `findPackages(dir)` and `resolveEntry(packageDir, target)` — package discovery and entry point resolution (below).
- `diffPackage(before, after): PackageDiff` and `diffApi(before, after): PackageDiff[]` — differences between versions; `versionBump(from, to)` and `normalizeSignature(signature)` are the pieces they use.
- `renderPackage(pkg, options)`, `renderSymbol(symbol)`, `renderDiff(diff)` — Markdown for LLM agents; `importPath(name, subpath)` gives the specifier code imports an entry with.
- Model: `ApiSurfaceData { packages }`, `ApiPackage { name, version?, description?, private, dir, entries, problems? }`, `ApiEntry { subpath, file?, symbols, truncated? }`, `ApiSymbol { name, kind, signature, doc?, deprecated?, file, line }`; `apiTotals(packages)`, `documentedPercent(totals)`, `apiSymbolKinds`, `isApiSymbolKind(value)`.

## How the API is read

1. **Packages** — the root `package.json` plus every workspace that `workspaces` (array or `{ packages }`) or `pnpm-workspace.yaml` lists, negated patterns excluded; packages without a `name` are skipped.
2. **Entry points** — each subpath of `exports` (wildcards and `./package.json` skipped), conditions tried in the order `types`, `typings`, `import`, `module`, `node`, `default`, `require`; without `exports`, `types`/`typings`/`module`/`main`, then `src/index.ts`, `index.ts`. A target resolves to the file itself when it is TypeScript, else a declaration next to it, else the source a build would have compiled it from (`dist/x.js` → `src/x.ts`, also `lib`, `build`, `out`, `esm`, `cjs`), else the JavaScript file. Packages with no entry point that resolves to a file are left out, e.g. an app without `exports` or a library whose build output is missing and whose sources live elsewhere.
3. **Exports** — declarations exported in place, `export { a as b }`, `export { x } from`, `export * from` (explicit exports win over star exports, `default` is never re-exported by a star), `export * as ns from` (a namespace listing its names) and `export default` / `export =`. Relative specifiers are followed across files (`./a.js` finds `./a.ts`, folders find `index`); re-exports of other packages stay as `reexport` entries naming the package. Cycles are cut.
4. **Declarations** — functions and overloads without bodies, classes without method bodies, private members or initializers (member doc comments kept as one line), interfaces, type aliases, enums and namespaces in full, constants as `const name: Type`, `const f = (a: T): R => …` or a short initializer. Lint directive comments (`// oxlint-…`, `// eslint-…`, `// @ts-…`) are dropped; the doc comment is the `/** */` block right before the declaration, even with such a comment in between. `@deprecated` text becomes `deprecated`.
5. **Caps** — 1000 symbols per entry point (the rest counted in `truncated`), 3000 characters per declaration, 1500 per doc comment, so one record stays a few hundred kilobytes for a large monorepo.

## Versions and diffs

Each record describes one ref: a release tag (from the default `tag` trigger or a release backfill with `api: true`) or the default branch (the weekly `api-weekly` schedule). `diffPackage` keys symbols by subpath and name: a missing one is `removed`, a declaration that differs after `normalizeSignature` (comments and layout ignored) is `changed`, a newly `@deprecated` one `deprecated`, a new one `added`. `required` is the bump the changes call for (`major` when anything was removed, `minor` for additions, changes or deprecations); `bumped` is what the version numbers did, where a minor bump of a `0.x` version counts as major. `semverWarning` is set when exports were removed without that bump. A changed declaration may still be compatible (an optional parameter added); the diff shows both versions instead of guessing.
