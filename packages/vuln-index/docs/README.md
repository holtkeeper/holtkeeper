# @holtkeeper/vuln-index

Vulnerability matching for a whole fleet without checkouts: the resolved packages of every repository's dependency graph ([@holtkeeper/depgraph](../../depgraph/docs/README.md)) are looked up in OSV in one batch, and each repository gets an `AuditReport` ([@holtkeeper/vuln](../../vuln/docs/README.md)) from the result. The server runs it as the vulnerability index duty, see [Vulnerability index](../../../apps/server/docs/README.md#vulnerability-index).

Only npm and Go are covered, the ecosystems `depgraph` reads. Other ecosystems still need `osv-scanner` in a checkout (the `audit` analyzer).

## Inventory

- `inventoryOf(data: DepgraphData, { isInternal? }): Inventory` — the third-party packages of the `packages` layers as `InventoryPackage { ecosystem, name, version, source }`, deduplicated:
  - npm: every `package` node with a registry version (links, `file:` and other non-versions are left out); `source` is the lockfile the layer came from: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` or the text `bun.lock` (npm aliases count under the real package name; the binary `bun.lockb` is not read, see [@holtkeeper/depgraph-js](../../depgraph-js/docs/README.md#lockfiles));
  - Go: only modules a main or workspace module requires in its `go.mod` (the graph's edges from workspace nodes; since Go 1.17 that lists every module providing a built package, while the rest of `go mod graph` comes from other modules' `go.mod` files and is never compiled), at the version the resolver selects (`selected !== false`), without the `v` prefix (how OSV and osv-scanner spell them); `source` is the module's `go.mod` (`<dir>/go.mod` from `go mod graph (<dir>)`, the single module's directory otherwise) or `go.work`;
  - packages `isInternal` names (the fleet's own packages) are left out, so a public advisory for the same name never matches.
- `Inventory.problem` says why the inventory must not be audited: a graph source failed (its packages are missing) or there is no `packages` layer (no lockfile the index reads). Callers write no report then.
- `INDEXED_ECOSYSTEMS` — `npm`, `Go`.

## Matching

- `matchPackages({ client, cache, packages, concurrency?, signal? }): Promise<MatchResult>` — one `OsvClient.queryBatch` over the distinct package versions, then the full record of every advisory found, taken from `cache` while its `modified` time is unchanged and fetched otherwise (`concurrency`, default 8, at once). `MatchResult` has `records` (advisories per `packageKey`, unaffected packages absent), `queried` and `fetched`. Advisories OSV no longer knows are left out; any other OSV failure throws, so a failed lookup never reads as "not affected".
- `packageKey({ ecosystem, name, version })` — the key of `records`.
- `VulnRecordCache { get(id), set(id, { modified, record }) }` and `kvRecordCache(kv, { ttlSeconds? })` — one `KvStore` key per advisory (`vuln-index:osv:<id>`), expiring after 30 days by default.

## Reports

- `indexAuditReport({ packages, records, allowlist?, traits?, now? }): AuditReport` — findings from `findingsForPackage` of [@holtkeeper/vuln-osv](../../vuln-osv/docs/README.md#osv-api) for every package, the allowlist applied with `applyAllowlist` as `runAudit` applies it, no fix attempts. `scanner` is `INDEX_SCANNER` (`osv-index`). Findings are sorted by source, package, version and id, so equal inputs give equal reports.
- `sameAuditState(a, b)` — whether two reports have the same active and allowlisted findings and expired entries, in any order; the scanner and fix attempts do not count. Lets a caller skip writing a record that changes nothing, also against a report `osv-scanner` made.
- `fixableKeys(report)` — active findings with a fixed version as `<advisory>|<ecosystem>|<package>|<version>`, sorted. A key that was not there before means a fix run has something new to work on: a new advisory, an advisory that got its first fixed version, or another resolved version of the package.
