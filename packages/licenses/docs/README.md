# @holtkeeper/licenses

The `licenses` analyzer and analysis kind: lists every third-party package of a checkout with the licenses its registry declares, judges them against an allow and a deny list of SPDX licenses, and reports violations, unknown licenses and the license mix, compared with the previous analysis.

## Public API

- `licensesAnalyzer` — `Analyzer<LicensesData, LicensesOptions>`, kind `licenses`, scope `repo`, needs `checkout`. Options (`licensesOptionsSchema`; each list also accepts a comma-separated string, which is how the flags `--allow`, `--deny`, `--ignore` pass them):
  - `allow: string[]` — SPDX ids, `*` patterns or whole expressions. Default `defaultAllow`: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0, Python-2.0, BlueOak-1.0.0.
  - `deny: string[]` — same forms. Default `defaultDeny`: `GPL-*`, `AGPL-*`, `SSPL-*`.
  - `ignore: string[]` — package names (`*` allowed, e.g. `@company/*`) whose licenses are not judged.
- `licensesAnalysis` — the `AnalysisKind` (`schema: licensesDataSchema`, `summarize`, `toReport(current, previous)`); `licensesReport(data, { previous?, ref?, compareTo?, generatedAt? })` builds the report directly.
- `analyzeLicenses({ dir, runner, policy?, binary?, args?, signal? }): Promise<LicensesData>` — runs osv-scanner through the `CommandRunner` and evaluates.
- `parseOsvLicenses(output, dir): ScannedPackage[]` — osv-scanner JSON to packages.
- `evaluatePackages(packages, policy)`, `resolvePolicy(options)` — pure policy application.
- `parseLicense(text)`, `formatLicense(node)`, `licenseEvaluator(policy)`, `evaluateLicenses(licenses, policy)` — the SPDX expression engine.
- Helpers: `isViolation`, `packageKey`, `licenseText`.

## How packages are found

```
osv-scanner scan source --recursive --allow-no-lockfiles --all-packages --licenses --format json [args] <dir>
```

With osv-scanner 2.7, `--licenses` without a value turns on license data (no allowlist, so osv-scanner does not judge anything itself) and `--all-packages` lists every package, not just vulnerable ones. Each package carries `licenses` (SPDX expressions from deps.dev, `UNKNOWN` when deps.dev has none) and, for lockfiles that record it, `dependency_groups` (e.g. `dev`). Exit codes 0 and 1 (vulnerabilities found) are a completed run. The version comes from `osv-scanner --version`.

A package found in several lockfiles becomes one entry with every source (relative to the checkout). `UNKNOWN` is dropped when the package also has a real license.

**Network:** license data comes from deps.dev; with `--offline` (through `args`) every package comes back unknown.

## Data

```ts
interface LicensesData {
  tool: { name: 'osv-scanner'; version?: string }
  policy: { allow: string[]; deny: string[]; ignore: string[] }
  packages: {
    name: string
    version: string
    ecosystem: string // OSV name: npm, Go, PyPI, ...
    sources: string[] // lockfiles, relative to the checkout
    licenses: string[] // SPDX expressions; empty = nothing known
    groups?: string[] // dependency groups, e.g. dev
    verdict: 'allowed' | 'unknown' | 'unlisted' | 'denied' | 'ignored'
    culprits?: string[] // licenses responsible for a verdict other than allowed
  }[]
}
```

Verdicts are computed when the analysis runs and stored with the policy used, so a report shows what was decided then.

## Evaluating licenses

Expressions follow SPDX: `AND` binds tighter than `OR`, parentheses group, `WITH` attaches an exception, a trailing `+` means "or later". Operators are matched in any case (`mit or apache-2.0`), ids case-insensitively.

Every license gets one of four verdicts, ordered from best to worst: `allowed` > `unknown` > `unlisted` > `denied`.

- A single license: `denied` if it matches the deny list, else `allowed` if it matches the allow list, else `unknown` for `LicenseRef-*`, else `unlisted`. Deny wins over allow. `X+` is allowed when `X` is allowed. `*` in a list entry matches within one id, so `GPL-*` matches `GPL-2.0+` and `GPL-3.0-only` but not `LGPL-2.1-only`.
- `A OR B` takes the best alternative (`MIT OR GPL-3.0` is allowed); `A AND B` takes the worst (`MIT AND GPL-3.0` is denied).
- `L WITH E` is judged as `L` unless the list contains the whole `L WITH E`, e.g. allow `GPL-2.0-only WITH Classpath-exception-2.0`.
- A list entry that is an expression (`MIT AND MPL-2.0`) matches that expression, or a parenthesized part of a larger one, regardless of operand order.
- `UNKNOWN`, `NOASSERTION`, `NONE`, `non-standard`, no license at all, and text that is not a valid expression are `unknown`.
- Several licenses declared for one package must all be acceptable; they are combined with `AND`.

`denied` and `unlisted` are violations; `unknown` is reported separately as a warning.

## Report

- **Metrics**: packages, license violations (`better: 'down'`; `bad` when something is denied, else `warning`), unknown licenses (`better: 'down'`), distinct licenses — each with a delta against the previous record.
- **Violations**: an `issues` block, denied first (`bad`) then not allowed (`warning`); each names package, version, license, the offending licenses, its source files and dependency kind; tags are the ecosystem, the dependency groups and `new` when the package was not a violation in the previous analysis. With a previous record, a table of new and resolved violations follows (packages are compared by ecosystem and name, so a version bump is not "new").
- **License mix**: a donut chart of packages by license expression; the twelve largest slices, the rest as `Other`.
- **Unknown licenses**: a table of packages whose licenses are unknown, with what was declared.
- **Packages**: every package with version, ecosystem, license, verdict (toned), kind (tags) and source. Clients filter and sort tables; it is capped at 2000 rows.

## Tests

- `src/spdx.test.ts` — evaluation table for the default policy (OR/AND/WITH/`+`/unknowns/invalid text) and custom policies.
- `src/parse.test.ts` — parser on `test/osv-npm.json`, captured from osv-scanner 2.7.0 over a copy of `fixtures/npm` with one package marked `dev` (vulnerability details removed).
- `test/osv-scanner.test.ts` — `analyzeLicenses` on a temp copy of `fixtures/npm`, replaying the captured output, since the real scan needs deps.dev.
- `src/analyze.test.ts`, `src/report.test.ts` — command line, options, verdicts, metrics with deltas, new and resolved violations, sections.
