# @holtkeeper/bundles

Measures what a frontend build or a published package ships and compares it between releases: total and initial-load bytes (raw, gzip, brotli) per entrypoint, per asset, and which npm packages and app modules make up the size. It reads the build output, so it works with any bundler: Vite, Rollup, webpack, esbuild, Bun.

## Pipeline

Each step is a separate export and can be replaced.

1. **Build** (optional) — `buildProject({ dir, command, runner?, env?, signal?, timeoutMs? })` runs the command the caller chooses (e.g. `['bun', 'run', 'build']`) through a `CommandRunner` from `@holtkeeper/exec` and throws `CommandError` on failure.
2. **Entrypoints** — an `EntrypointResolver` turns the dist directory into `{ name, initial, lazy }[]`. `followImports` then completes the lists by scanning ES module `import` / `export from` (initial) and `import()` (lazy) in the JS files.
3. **Measure** — every file in dist except `defaultIgnore` (`**/*.map`, `.vite/**`, `**/stats.json`, `**/webpack-stats/**`, `asset-manifest.json`), precompressed copies (`x.js.gz`, `x.js.br` next to `x.js`) and `ignore` globs gets a kind (`js`, `css`, `html`, `image`, `font`, `other`), raw size, gzip (level 9) and brotli (quality 11) size.
4. **Names** — `normalizeAssetNames` removes content hashes so assets match across builds (`assets/index-B3x9kQz1.js` → `assets/index.js`, `main.3f2a1b9c.css` → `main.css`). Hashes made only of lowercase letters are recognised by learning the hash length and alphabet from the rest of the build. When two files still share a name (`chunk-a.js`, `chunk-b.js`), each gets the first source of its source map: `chunk.js [react]`, `chunk.js [src/lazy.ts]`. Pass `normalizeName` to use your own rule.
5. **Attribution** — source maps of JS and CSS split each asset's bytes between original sources, which `sourceOrigin` maps to npm packages or app modules.
6. **Compare and report** — `compareBundles(previous, current)` diffs two results; `bundleAnalysis` turns them into a `Report`.

```ts
import { analyzeBundle, bundleAnalysis } from '@holtkeeper/bundles'

const data = await analyzeBundle({
  dist: 'dist',
  build: { dir: '/path/to/app', command: ['bun', 'run', 'build'] },
})
```

## Pointing it at a build

| Bundler          | What to enable                                                                          | Resolver used                           |
| ---------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| Vite / Rollup    | `build.manifest: true`, `build.sourcemap: true` (or `'hidden'`)                         | `viteManifestResolver`                  |
| webpack          | `devtool: 'source-map'`; write `stats.json` into `output.path`, or rely on `index.html` | `webpackStatsResolver` / `htmlResolver` |
| Create React App | `GENERATE_SOURCEMAP=true` (default); `asset-manifest.json` is read                      | `webpackStatsResolver`                  |
| esbuild / Bun    | `sourcemap: 'linked'` or `'external'`, ES module output                                 | `htmlResolver` / `importGraphResolver`  |

Without `entries` or `resolver`, `analyzeBundle` tries `defaultResolvers()` in order and uses the first one that finds anything:

- `viteManifestResolver()` — `.vite/manifest.json` or `manifest.json`: each `isEntry` chunk with its CSS and static imports, recursively; `dynamicImports` become lazy. HTML entries (`src: 'index.html'`) include the page.
- `webpackStatsResolver()` — `stats.json` `entrypoints[name].assets`, lazy chunks through `chunks[].children`; or `asset-manifest.json` with an `entrypoints` list.
- `htmlResolver()` — one entrypoint per HTML page (`index.html` → `index`, `admin/index.html` → `admin`): the page, `<script src>`, `<link rel=stylesheet|modulepreload|preload>` and imports in inline module scripts. Root-relative URLs with a deploy base (`/app/assets/x.js`) are matched to dist files, also relative to the page's folder when the site root is a subfolder of dist (`frontend/game.html` loading `/scripts/x.js`).
- `importGraphResolver()` — every JS file that no other JS file imports.

Configure entrypoints explicitly with `entries: [{ name: 'admin', globs: ['assets/admin-*.js'] }]`, or pass any `resolver`; combine your own with `firstEntrypoints(...resolvers)`. Set `followImports: false` when the resolver already returns complete lists.

## Data

`analyzeBundle` returns `BundleData`, plain JSON validated by `bundleDataSchema`:

- `assets[]` — `file`, normalized `name`, `kind`, `raw`, `gzip`, `brotli`, `mapped` (bytes explained by a source map).
- `entrypoints[]` — `name`, `initial` and `lazy` files, `initialSize` and `lazySize`, `packages` (npm packages plus `(app)` and `(unmapped)`) and app `modules` over initial and lazy JS/CSS.
- `packages[]` — every package over all assets with `bytes`, `gzip`, `versions` (from pnpm/bun store paths or the installed `package.json`), `instances` (install paths; more than one means it is bundled twice), `modules` and `entrypoints`.
- `modules[]`, `unmapped`, `tool` (`vite`, `webpack`, `bun`, ... when recognised), `build` (command and duration when it ran).

## Targets

A `bundle` record holds `BundleRecordData { targets }`: every thing one run measured. A `BundleTarget` has a `name`, a `source` (`build` or `package`), for packages a `version` and its publish time `at`, a `status` and either `data` (`BundleData`) or, when `failed`, the `error`. Package targets add `package: PackageInfo` (`unpacked` bytes and `files` of the whole archive, `dependencies`, `peerDependencies`). Records from before targets hold a bare `BundleData`; `bundleTargets(data)` reads both (the old shape is one `app` build) and `bundleAnalysisSchema` validates both.

- `analyzeBuildTarget({ name, dir, dist, command?, runner?, env?, entries?, ignore?, root?, signal?, timeoutMs? })` builds (when `command` is set) and measures one target. `dist` may list candidates; the first that exists after the build is measured. It never throws for a failed build or a missing output: the target comes back `failed` with the end of the error, so a release that no longer builds is a gap in history. Aborts still reject.
- `analyzePackage({ name, version, files, publishedAt? })` measures one published version from its unpacked archive (paths without the top folder). Assets are the shipped files without declarations, Markdown, licenses, changelogs and `package.json` (`packageIgnore`); entrypoints are its export subpaths (`packageEntries`: the `browser`, `import`, `module`, `default`, `require` or `node` target of each `exports` subpath, never `types`, `*` patterns expanded over the archive up to 100; without `exports` the `module`, a string `browser` or `main` field), completed by following ES module imports inside the package; source maps the package ships attribute bytes. Imports of dependencies are not followed: sizes are the package's own code. Failures become a `failed` target.
- `bundleSeries(records)` turns `bundle` records (`{ id, createdAt, ref?, data }`) into one `BundleSeries { name, source, points }` per target name, sorted by name. Builds get one point per record; a package version counts once, from the newest record measuring it. Points (`BundlePoint`) carry the record id, ref, version, `at` (publish time, else the record's), status and error, total sizes, JS and CSS gzip, initial and lazy sizes per entrypoint and `PackageInfo`, ordered by `at`.
- `findTargetPoint(records, { name, version?, analysisId? })` locates one point (newest without either) and the closest earlier point that measured fine; `targetReport(current, previous?)` renders it like a single build, plus a **Package** section with archive size, files and dependencies (new ones tagged) for package targets.

## Report

A record with one target is reported like that target (`targetReport`, compared with the target of the same name in the previous record). A record with several shows metrics over all of them (total gzip of measured targets, targets, not measured) and a **Targets** table with each one's sizes, change against the same target in the previous record, largest initial load and status; failed targets and changes over the thresholds are listed above it. The details of one target are on the Bundles page of the web app.

For a single target, `bundleAnalysis` (kind `bundle`, or `createBundleAnalysis({ growthPercent, growthBytes, heavyPackageBytes, treemapModules })` for other thresholds) produces:

- **Metrics** — JS gzip, CSS gzip, initial load of the largest entrypoint, number of entrypoints, number of packages; deltas against the previous record, `better: 'down'` for sizes.
- **Overview** — bar chart of initial gzip per entrypoint (previous vs current) and issues: entrypoints that grew or shrank by more than 5 % or 10 kB gzip, new packages over 5 kB gzip, packages that grew by more than 10 kB, packages newly bundled in several versions (or all duplicates when there is no previous record).
- **Entrypoints** — raw / gzip / brotli of the initial load with deltas, lazy size with delta, and a table of lazy chunks per entrypoint.
- **Composition** — treemap entrypoint → package, with `(app)` broken down into modules.
- **Packages** — raw and estimated gzip size, delta, share of all JS and CSS gzip, versions, entrypoints, `added` / `removed` / `duplicate` tags.
- **Assets** — normalized name, file, kind, sizes, delta, `added` / `removed` / `changed` tags.

## Attribution limits

- Bytes are attributed per source map segment: a segment owns the generated text up to the next segment on the line. Text before the first segment of a line, segments without a source, line breaks, and files without a map count as `(unmapped)`. Totals always add up to the asset size.
- Package gzip sizes are estimates: each asset's gzip size is split in proportion to raw bytes. Raw bytes are exact.
- Bundler-generated code (runtime, helpers, module wrappers) is often unmapped or mapped to the first module of a chunk. Vite and webpack runtime ids map to `vite` and `webpack`; other virtual ids (`\0...`) to `(virtual)`.
- Index source maps (`sections`) are not supported; their assets count as unmapped.
- Package versions need pnpm/bun store paths or the project's `node_modules` on disk at analysis time; otherwise duplicates are detected by install path only.
- Import following uses a regex over ES module output. CommonJS or SystemJS chunks and imports built from expressions are not followed; use a manifest resolver or `entries` for them.
- Paths in source maps resolve against the map's directory and are reported relative to `root` (default: `build.dir`, else the parent of `dist`). In monorepos, set `root` to the app directory; sources outside it keep `../` paths.
