# @holtkeeper/depgraph-go

A `GraphSource` for Go modules and `go.work` workspaces. See `@holtkeeper/depgraph` for the model and analyses.

```ts
import { analyzeDependencies } from '@holtkeeper/depgraph'
import { goSource } from '@holtkeeper/depgraph-go'

const data = await analyzeDependencies({ dir, sources: [goSource({ runner })] })
```

## Public API

- `goSource({ runner?, depth?, timeoutMs? }): GraphSource` — named `go`. `runner` defaults to `localRunner`.
- `goEnv` — environment of every `go` command.
- Pure helpers: `parseGoMod`, `parseGoWork`, `parseGoModGraph(output, modules)`, `goWorkspaceGraph(modules)`, `findGoModules(dir, depth)`, `readGoModules(dir, dirs)`.

## Layers

- **workspaces** — with `go.work`, its `use` directives; otherwise every `go.mod` found up to `depth` (default 4) directories deep, skipping `node_modules`, `vendor`, `testdata` and hidden directories. Nodes are module paths (`kind: 'workspace'`, ecosystem `Go`); an edge means one workspace module `require`s another.
- **packages** — `go mod graph`. With `go.work` it runs once at the root (`GOWORK` set to that file); otherwise once per module with `GOWORK=off`, one layer each (`go mod graph (<dir>)` when there are several), because separate modules are separate builds. Main and workspace modules are workspace nodes whatever version they are referenced by; other modules are `path@version` package nodes. The `go` and `toolchain` pseudo-modules are dropped.

## Duplicates

`go mod graph` lists every version any module in the graph requires. Minimal version selection builds with the highest one, so that node gets `selected: true` and the others `selected: false`. `findDuplicates` reports modules with several versions in the graph; reports show which version is selected and which were only requested, with the path that requests each.

## Environment

`GOTOOLCHAIN=local` (never download a toolchain) and `GOFLAGS=-mod=mod` (resolve even when `go.sum` or `vendor/` is stale; replaces the caller's `GOFLAGS`). `GOPROXY`, `GOPRIVATE` and credentials come from the caller's environment.

## Limitations

- `go mod graph` downloads module metadata (`go.mod` files) when the module cache lacks it, and with `-mod=mod` it may update `go.mod`/`go.sum`. Run it on a disposable checkout.
- The selected version is computed from the graph (the highest version present), not from `go list -m all`; `exclude` and `retract` are not taken into account, and `replace` directives are only reflected through what `go mod graph` prints.
- No source-level (package import) layer for Go yet.
