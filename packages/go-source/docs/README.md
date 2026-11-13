# @holtkeeper/go-source

Everything Holtkeeper knows about Go source, in TypeScript: no Go toolchain, no network, no parser dependency. Module discovery and `go.mod` parsing, the public API of a module, import paths resolved to modules, package-level uses in a file, and which module a git tag releases. The one exception is the optional typed usage pass (`goTypedUsages`), which runs a small Go helper shipped as source with the job's own `go`. `libraries`, `depgraph-go`, `api-surface`, `usages` and `quality-tests` build on it.

```ts
import {
  discoverGoModules,
  goModuleApi,
  resolveGoImport,
  scanGoUsages,
} from '@holtkeeper/go-source'

const { modules } = await discoverGoModules(checkout)
const api = goModuleApi(filesOfModule, { includeInternal: true })
const { imports, sites } = scanGoUsages(source)
const where = resolveGoImport(sites[0].importPath, owningModule, modules)
```

## Modules and go.mod

- `parseGoMod(content): GoMod` — `module`, `go`, `require` (`{ path, version, indirect? }`, `indirect` only for a `// indirect` marker), `replace` (`{ path, version?, to, toVersion?, local }`; `local` when the target is a directory: `./`, `../` or absolute) and `exclude` (`{ path, version }`), from both the single-line and the block forms.
- `parseGoSum(content): GoSumEntry[]` — the lines of a `go.sum` as `{ path, version, kind }`, `kind` `go.mod` for `v1.2.3/go.mod` lines (hash of the `go.mod` only) and `module` for the tree hash; malformed lines are skipped.
- `parseGoWork(content)` — the `use` directories of a `go.work`, normalized.
- `findGoModules(dir, depth = 4)` — directories holding a `go.mod`, `.` first, skipping `node_modules`, `vendor`, `testdata` and hidden directories.
- `readGoModules(dir, dirs): GoWorkspaceModule[]` — `{ module, dir, mod }` per directory with a `go.mod` that names a module.
- `discoverGoModules(dir, depth = 4)` — the `go.work` members when the root has a `go.work` (`workspace: true`), otherwise every `go.mod` found.
- Module helpers: `libraryOfModule` (drops the `/vN` suffix), `modulePathOf(name, version)`, `isPseudoVersion`, `compareGoVersions`, `isStableGoVersion`, `escapeModulePath`.

## Public API

`goModuleApi(files, { module?, version?, maxSymbols?, includeInternal? }): GoModuleApi` reads one module's files (paths relative to the module root) and returns `{ module, packages, mainPackages, internalPackages }`:

- One `ApiPackage` per library package directory: `name` is the full import path, `dir` is relative to the module root, `ecosystem: 'Go'`, `module` is the module path, and a single entry `.` lists exported functions, methods (`Type.Method`), types (`type` or `interface`), constants and variables (`variable`; the signature starts with `const` or `var`), with doc comments, `Deprecated:` paragraphs as `deprecated` and the package doc's first sentence as `description`. Unexported struct fields show as `// contains filtered or unexported fields`.
- Packages under `internal/` are counted in `internalPackages`, and listed with `private: true` only with `includeInternal` (default false).
- `package main` directories are counted in `mainPackages` and never listed. A service made of `cmd/` and `internal/` has `packages: []` and non-zero counts.
- Skipped: `vendor/`, `testdata/`, `_` and `.` directories, directories of nested modules (another `go.mod` below the root), `_test.go` files, `*_test` packages and files with `//go:build ignore`. Other build constraints are not applied; a symbol declared per platform appears once, the generic file winning.

`goApi(files, options)` is the importable-only list (`includeInternal: false`) without counts, as the third-party library index uses it. `parseGoDoc(lines)` splits a doc comment into `doc` and `deprecated`.

The scan reads gofmt-formatted source line by line and by brackets (`mask` blanks comments and strings first); unformatted code with several declarations on one line may be read incompletely.

## Imports and modules

`resolveGoImport(importPath, owning, modules): GoImportResolution` says where an import of a file in module `owning` leads. It takes the longest module path that is a prefix at a `/` boundary:

1. Modules of the repository (`owning` and `modules`: own, nested and `go.work` members) give `{ kind: 'local', module, subpath, dir }`.
2. Otherwise the owning `go.mod`'s `require` and `replace` paths. A `replace` with a directory target gives `local` (with `dir` when it stays inside the repository); one with a module target gives `{ kind: 'external', module, subpath, version: <target version>, required, replacedBy }`; a plain `require` gives `{ kind: 'external', module, subpath, version, indirect? }`. A versioned `replace` applies only when it names the required version.
3. An import whose first element has no dot is `{ kind: 'stdlib' }` (`isStdlibImport`), checked after the repository's modules so an own module path without a dot stays local.
4. Anything else is `{ kind: 'unresolved' }`.

`subpath` is `.` for the module's root package, else `./sub/pkg`, so module path plus subpath rebuilds the import path. `module` keeps its `/vN` suffix. Since Go 1.17 the main module's `go.mod` lists every module that provides an imported package, so the `require` version is the version built with.

## Usages

`scanGoUsages(source, packageNames?): GoUsageScan` returns the file's `packageName`, its `imports` (`parseGoImports`: `{ path, alias?, name?, line, column, offset }`) and its `sites`: `{ importPath, export, member?, kind, props?, line, column, offset }`, positions 1-based and UTF-16, pointing at the start of `pkg.Name` (at the path for `import` sites).

| Code                                                                       | Kind        |
| -------------------------------------------------------------------------- | ----------- |
| `pkg.F(…)`, `pkg.F[T](…)`, conversions `pkg.T(x)`                          | `call`      |
| `pkg.T{A: 1}`, `&pkg.T{…}`, `pkg.T[int]{…}` (keys in `props`)              | `new`       |
| declarations, parameters, results, fields, `*`, `[]`, `map`, `chan`, `...` | `type`      |
| type assertions `x.(pkg.T)`, type switch cases, constraints `[T pkg.C]`    | `type`      |
| `pkg.T` alone on a struct or interface line                                | `extends`   |
| `type X = pkg.Y`                                                           | `reexport`  |
| `pkg.V.X`, `pkg.T.M` (`member` is `X`, `M`, or a `.`-joined chain)         | `member`    |
| anything else (`if err == pkg.ErrX`, arguments, `<-pkg.Done`)              | `reference` |
| blank `_` and dot `.` imports, named imports never referred to             | `import`    |

The name a package is referred to by is its alias, else `packageNames.get(path)`, else `defaultPackageName(path)` (last element, skipping `/vN`, without `.vN`, `go-` and `-go`). Names a dot import brings in are not resolved. Local names that shadow a package, methods called on values a package returned and type arguments of instantiations (`List[pkg.T]`, read as `reference`) need type information and are out of reach. Standard library imports are scanned like any other; drop them with `isStdlibImport`.

## Typed usages

`goTypedUsages({ dir, runner, runs, timeoutMs?, maxSites?, signal?, log? }): Promise<GoTypedOutcome>` asks the Go type checker what the syntactic scan cannot see: fields and methods reached through values. `c := canvas.New(); c.Draw(s)` gives `{ file, line, column, importPath: '…/canvas', export: 'Canvas', member: 'Draw', kind: 'call' }`; a field read or a method value is `member`. The export is the exported type declaring the member, or the innermost exported type on the selection path when an unexported embedded type declares it. Chains rooted at a package name (`pkg.V.X`, `pkg.T.M`) are left to `scanGoUsages`; types of the standard library and of the run's own modules are left out. Positions are 1-based with UTF-16 columns, pointing at the member name, so they line up with `scanGoUsages`.

- `runs: GoTypedRun[]` — `{ dir, gowork?, patterns? }`, paths relative to the checkout: a single module (`GOWORK=off`, patterns `./...`), or a `go.work` with the member patterns (`./api/...`).
- The helper lives in `helper/typedusages` (`main.go` and a `go.mod` with no requirements, standard library only). It is not built ahead of time: each call copies it into a hidden `.holtkeeper-typedusages-*` folder of the checkout (so a container runner sees it too), runs it with `go run .` through `runner` (`GOTOOLCHAIN=local`, `GOWORK=off`; the job's `GOFLAGS` pass through) and deletes the folder.
- The helper runs `go list -e -export -deps -test` (`CGO_ENABLED=0`; `-mod=mod` for a single module when `GOFLAGS` sets no `-mod`), so missing modules download through the job's proxy and `GOPRIVATE` settings and the build cache holds export data. It then parses every package of the run's main modules, `_test.go` files and external test packages included, and type-checks it with `go/types` against that export data. Type errors are collected, not fatal.
- `GoTypedOutcome { status, reason?, sites, packages, errors, truncated? }`: `skipped` when `go version` fails or there are no runs, `failed` when no run succeeded (reason: the first error), else `used` with the sites of the runs that succeeded and up to 50 `errors` (type errors, package errors and failed runs, prefixed by the run's `dir`). Never throws except on abort.
- Bounds (`goTypedDefaults`): `timeoutMs` 5 minutes over all runs (the helper stops itself; the runner's timeout adds a minute for compiling), `maxSites` 100 000, helper output 64 MiB.

## Tags

`goModuleTags(tags, modules): GoModuleTag[]` maps git tags to the modules they release, following Go's rules: `vX.Y.Z` releases the root module, `dir/vX.Y.Z` the module at `dir`; a module in a major-version directory (`v2`, `dir/v3`) takes tags without that directory. The tag's major must match the module path (`/vN` paths only `vN`, other paths only `v0` and `v1`). Tags that are not semantic versions or match no module are left out.
