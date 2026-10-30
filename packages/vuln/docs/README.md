# @holtkeeper/vuln

Language-independent contracts and orchestration for vulnerability audits: what a finding is, what scanners and fixers do, how the allowlist works, and how an audit run combines them. It has no knowledge of any tool or ecosystem; implementations live in their own packages.

| Package                                                 | Implements                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@holtkeeper/vuln-osv`](../../vuln-osv/docs/README.md) | `Scanner` via `osv-scanner scan`, `Fixer` via `osv-scanner fix` (npm, Maven) |
| [`@holtkeeper/vuln-js`](../../vuln-js/docs/README.md)   | `Fixer` for npm, bun, pnpm and yarn projects via ranges and overrides        |
| [`@holtkeeper/vuln-go`](../../vuln-go/docs/README.md)   | `Fixer` for Go modules via `go get`                                          |

## Finding

One advisory affecting one package version in one source file:

```ts
interface Finding {
  id: string // primary id, usually GHSA or an OSV id
  aliases: string[] // CVE and other ids of the same advisory
  summary: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown'
  url: string
  package: { name: string; version: string; ecosystem: string } // OSV ecosystem names
  source: string // lockfile or manifest, relative to the scanned directory
  fixedVersions: string[] // fixes applicable to this version, lowest first
}
```

`findingKey(finding)` identifies a finding across scans (id, ecosystem, package, source — not version), which is how an audit decides what a fix resolved.

## Scanner and Fixer

```ts
interface Scanner {
  readonly name: string
  scan(dir: string, options?: { signal?: AbortSignal }): Promise<Finding[]>
}

interface Fixer {
  readonly name: string
  supports(source: string): boolean
  fix(request: { dir; source; findings; signal? }): Promise<{ changedFiles; fixed; notes }>
}
```

A fixer receives the findings of one source file. It returns the files it changed (relative to `dir`), the ids it expects to be fixed and notes for the report. Its claims are only hints: the audit rescans and trusts the rescan. `trackChanges(dir, files, action)` helps fixers report changed files by comparing file hashes around an action.

## Allowlist

```ts
{
  id: 'GHSA-xxxx-xxxx-xxxx',   // advisory id or any alias
  reason: 'SSR-only issue',    // required
  author: 'jane',
  expires: '2026-12-31',       // last day the entry applies
  package: 'next',             // only this package
  paths: ['apps/web/**'],      // only sources matching these globs
  when: { ssr: false },        // only repositories with these traits
}
```

`applyAllowlist(findings, entries, { now, traits })` returns `active` and `ignored` findings plus `expired` entries. Expired entries hide nothing and are reported so someone renews or removes them. `allowlistSchema` validates a list of entries.

The allowlist is applied by Holtkeeper after scanning instead of being handed to the scanner, so it behaves the same with any scanner.

## runAudit

```ts
const report = await runAudit({ dir, scanner, fixers, allowlist, traits })
```

1. Scan and apply the allowlist.
2. Without fixers, or with nothing to fix, return.
3. For every source file, try fixers in order. Each supporting fixer gets the findings the previous ones did not claim; a fixer that throws is recorded and the next one continues. Fixers run sequentially.
4. If any file changed, rescan and apply the allowlist again.

The report lists remaining `findings`, `ignored`, `expired`, every `FixAttempt` (fixer, source, requested and claimed ids, changed files, notes, error), the `resolved` findings and all `changedFiles`.

## Adding an ecosystem

Write a package with a `Fixer` for the ecosystem's manifest or lockfile and put it in the fixer chain after the osv fixer. Nothing in this package changes. A new scanner works the same way: implement `Scanner` and map its output to `Finding`.
