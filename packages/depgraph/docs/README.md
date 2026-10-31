# @holtkeeper/depgraph

Language-neutral dependency graphs: the contract graph sources implement, pure analyses (cycles, libraries in several versions, statistics) and the `depgraph` analysis kind that turns the result into a universal `Report`.

## Model

- `DepGraph { nodes: DepNode[]; edges: DepEdge[] }`. Ids are unique within one graph; edges only refer to nodes of the same graph.
- `DepNode { id; name; version?; ecosystem; kind; path?; workspace?; selected? }`
  - `ecosystem` uses OSV spelling (`npm`, `Go`). Nodes with the same `ecosystem` and `name` are one library.
  - `kind`: `workspace` (the repository's own package or module), `package` (third-party, resolved version), `module` (a source file).
  - `workspace`: the workspace a source file belongs to.
  - `selected`: only for ecosystems that build with one version per library (Go): whether the resolver picked this version.
- `DepEdge { from; to; kind }` with `kind` one of `prod`, `dev`, `peer`, `optional`, `import`.
- `GraphLayer { id: 'workspaces' | 'packages' | 'modules'; source; graph }`.
- `GraphSource { name; detect(dir); load(dir) }` — implemented by `@holtkeeper/depgraph-js` and `@holtkeeper/depgraph-go`. A source may return several layers.

## Analyses

All pure and deterministic.

- `findCycles(graph): Cycle[]` — Tarjan's strongly connected components (iterative, safe for deep graphs). One entry per component with more than one node or a self-loop: `members` (sorted) and `path`, one shortest closed cycle (`[a, b, c, a]`).
- `findDuplicates(graph): Duplicate[]` — `package` nodes with the same ecosystem and name in more than one version. Each version lists its direct `dependents` and one shortest `path` from a workspace (or from nodes nothing depends on, when there are no workspaces).
- `graphStats(graph, { top? }): GraphStats` — counts by kind and ecosystem, direct vs transitive dependencies, `mostDependedOn` (top N by direct dependents) and `deepestChain` (shortest path to the node farthest from all workspaces).
- `compareVersions(a, b)` — semver-style ordering, accepts Go's `v` prefix.
- `GraphBuilder` — helper for sources: deduplicates nodes and edges (`prod` wins over other kinds) and drops edges to unknown nodes.

## Inventory across repositories

All pure.

- `directDependencies(data): DirectDependency[]` — edges from workspaces to packages in the `packages` layers: `{ ecosystem, name, version, workspace, kind }`, one per workspace and library (`prod` wins over `peer`, `optional`, `dev`). Where the resolver selects one version (Go), the selected version replaces the requested one.
- `ownPackages(data): OwnPackage[]` — versioned workspaces, i.e. packages the repository defines.
- `versionDrift(versions): 'none' | 'patch' | 'minor' | 'major'` — between the lowest and highest version; `major` when they are not semver-compatible (below 1.0 a minor bump is breaking).
- `fleetLibraries(entries: { origin, data }[]): FleetLibrary[]` — one entry per library across repositories: `versions` in use, `latest` (highest in use, or the version in the fleet's own `source` when higher), `drift`, `usages` with their `lag` behind `latest`, and `behind` (usages with a lag). Sorted by drift, then `behind`, then usage count.

## Internal packages

Packages the analyzed repositories define, for analyses that must tell them from third-party ones (licenses, fleet).

- `latestDepgraphs(analyses, { accept? })` — the newest valid `depgraph` record of every repository from an `AnalysisStore`, by `forge:path` (`newestRecords` from [@holtkeeper/store](../../store/docs/README.md)): one record per repository, older ones only where the newest is not a valid graph; `accept` leaves out repositories by their newest record (e.g. by visibility).
- `packageCatalog(entries: { repo, data }[]): PackageCatalog` — every versioned workspace (`ownPackages`) with the repository that defines it; when several define the same package, the highest version wins. `find(ecosystem, name)` returns `InternalPackage { ecosystem, name, version, repo, path? }`.
- `loadPackageCatalog(analyses, options?)` — both together.

## Running sources

`analyzeDependencies({ dir, sources }): Promise<DepgraphData>` runs every source whose `detect` is true. A source that throws ends up in `errors`; the other layers are kept.

```ts
interface DepgraphData {
  layers: { id; source; graph; cycles; duplicates; stats }[]
  errors: { source: string; message: string }[]
}
```

Graphs are stored complete (the `packages` layer of a monorepo can have thousands of nodes); reports summarize. `depgraphDataSchema` (zod) validates uploaded data.

## Report

`depgraphAnalysis` (`kind: 'depgraph'`, label `Dependencies`) and `depgraphReport(data, { previous?, ref?, compareTo? })`.

Metrics: workspaces, packages, duplicated libraries, workspace cycles, module cycles. Deltas against the previous record; problem metrics have `better: 'down'` and a `warning`/`bad` tone when non-zero.

Sections:

1. **Issues** — workspace, package and module cycles (`bad`) with the cycle path; duplicated libraries (`warning`) with one path per version; failed sources. Package cycles made only of workspaces are skipped (they are already workspace cycles). At most 100 items.
2. **Workspaces** — a `graph` block per workspace layer, `layered` layout, cycle paths in `highlight`, cycle edges `bad`, non-prod edges dashed.
3. **Duplicates** — table of library, version (Go: selected or requested), pulled in by, path, grouped by library; with a previous record, a table of duplicates that are new or resolved.
4. **Module cycles** — issues listing the files of each cycle, tagged with the workspace. At most 50.
5. **Most used** — top 15 most depended-on packages and the deepest chain.
6. **Packages overview** — direct/transitive/edge counts and a stacked bar chart of nodes by ecosystem and kind.
