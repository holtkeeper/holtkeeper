# @holtkeeper/licenses

The `licenses` analyzer and analysis kind: lists every third-party package of a checkout with the licenses its registry declares, judges them against an allow and a deny list of SPDX licenses, and reports violations, unknown licenses and the license mix, compared with the previous analysis.

## Public API

- `licensesAnalyzer` — `Analyzer<LicensesData, LicensesOptions>`, kind `licenses`, scope `repo`, needs `checkout` and `history` (for [internal packages](#internal-packages) and the [dev-only fallback](#dev-only-packages)), runs `after: ['depgraph']`. Options (`licensesOptionsSchema`; each list also accepts a comma-separated string, which is how the flags `--allow`, `--deny`, `--ignore` pass them):
  - `allow: string[]` — SPDX ids, `*` patterns or whole expressions. Default `defaultAllow`: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0, Python-2.0, BlueOak-1.0.0, MIT-0, BSD-1-Clause, Zlib, BSL-1.0, PSF-2.0, X11, Unicode-3.0, Unicode-DFS-2016, CC-BY-3.0, CC-BY-4.0. LGPL and other weak copyleft stay off it: neither allowed nor denied, they show up as not allowed for review.
  - `deny: string[]` — same forms. Default `defaultDeny`: `GPL-*`, `AGPL-*`, `SSPL-*`.
  - `ignore: string[]` — package names (`*` allowed, e.g. `@company/*`) whose licenses are not judged.
  - `review: string[]` (`--review`) — licenses that need a sign-off even when `allow` matches them: they are judged `unlisted` (needs review). `deny` still wins. Default none.
  - `unknown: 'warn' | 'violation'` (`--unknown`) — default `warn` reports unknown licenses separately; `violation` judges them `unlisted` (not allowed), with the declared text or `UNKNOWN` as culprit.
  - `devDependencies: 'check' | 'ignore'` (`--dev-dependencies`) — default `check`; `ignore` gives dev-only packages the verdict `ignored` (see [Dev-only packages](#dev-only-packages)).
  - `exceptions: LicenseException[]` — packages accepted although their license would not pass (see [Exceptions](#exceptions)). Default none, at most 500.
  - `requireProjectLicense: boolean` (`--require-project-license`) — default false; when true, a repository without a license file at its root gets a warning.
  - `presets` — `licensePresets`, offered by the panel for the `analyzers.licenses` setting (see [Presets](#presets)).
- `licensesAnalysis` — the `AnalysisKind` (`schema: licensesDataSchema`, `summarize`, `toReport(current, previous)`); `licensesReport(data, { previous?, ref?, compareTo?, generatedAt? })` builds the report directly.
- `analyzeLicenses({ dir, runner, policy?, internal?, devOnly?, binary?, args?, signal? }): Promise<LicensesData>` — runs osv-scanner through the `CommandRunner` and evaluates. `devOnly: (ecosystem, name, version) => boolean` (`DevOnlyPackages`) is the fallback for packages without dependency groups.
- `parseOsvLicenses(output, dir): ScannedPackage[]` — osv-scanner JSON to packages.
- `npmTarball(name)` — `{ name, version }` of an npm tarball URL (`<registry>/<name>/-/<file>-<version>.tgz`), else `undefined`.
- `isDevOnly(groups)` — whether dependency groups make a package dev-only; `withDevFallback(packages, devOnly)` gives packages without groups `groups: ['dev']` when `devOnly` names them.
- `analyzeLicenses` also takes `today` (`YYYY-MM-DD`, default today in UTC): exceptions that expired before it are left out of the run's policy.
- `evaluatePackages(packages, policy, internal?)`, `resolvePolicy(options, today?)` — pure policy application; `internal: (ecosystem, name) => 'forge:path' | undefined` names the repository that defines a package. With `today`, `resolvePolicy` drops expired exceptions.
- `licenseExceptionSchema`, `LicenseException` — one exception as the options and the stored policy carry it.
- `projectLicenseFiles(dir)` — names of license files at the root of `dir` (`LICENSE`, `LICENCE`, `COPYING`, `UNLICENSE`, with any `.`/`-`/`_` suffix such as `LICENSE.md` or `LICENSE-MIT`).
- `parseLicense(text)`, `formatLicense(node)`, `licenseEvaluator(policy)`, `evaluateLicenses(licenses, policy)` — the SPDX expression engine.
- Helpers: `isViolation`, `packageKey`, `licenseText`.

## How packages are found

```
osv-scanner scan source --recursive --allow-no-lockfiles --all-packages --licenses --format json [args] <dir>
```

With osv-scanner 2.7, `--licenses` without a value turns on license data (no allowlist, so osv-scanner does not judge anything itself) and `--all-packages` lists every package, not just vulnerable ones. Each package carries `licenses` (SPDX expressions from deps.dev, `UNKNOWN` when deps.dev has none) and, for lockfiles that record it, `dependency_groups` (e.g. `dev`). Exit codes 0 and 1 (vulnerabilities found) are a completed run. The version comes from `osv-scanner --version`.

A package found in several lockfiles becomes one entry with every source (relative to the checkout). `UNKNOWN` is dropped when the package also has a real license.

osv-scanner names `yarn.lock` entries resolved from a registry it does not know (a GitLab package registry, for one) by their tarball URL with ecosystem `GIT`, e.g. `https://gitlab.example.com/api/v4/projects/123/packages/npm/@acme/some-lib/-/@acme/some-lib-1.2.3.tgz`. Any `http(s)` name of the npm tarball shape `/<name>/-/<file>-<version>.tgz` (any host, scoped or not, file with or without the scope) becomes ecosystem `npm`, that name and version before anything else happens, so internal detection, `ignore`, exceptions and merging with other lockfiles see the real package.

## Dev-only packages

A package is dev-only when every dependency group is `dev` or `optional` and at least one is `dev` (`['dev', 'optional']` is dev-only, `['optional']` is not). Groups come from osv-scanner's `dependency_groups`, which `yarn.lock`, `bun.lock` and some `package-lock.json` files do not carry. For packages without groups the analyzer falls back to the repository's own newest `depgraph` record: a package that record reaches only through dev edges (`devOnlyPackages` of [@holtkeeper/depgraph](../../depgraph/docs/README.md#inventory-across-repositories), same ecosystem, name and version) gets `groups: ['dev']`. The record may lag the checkout by one run; packages it does not know stay without groups and are checked. The analyzer runs `after` `depgraph` jobs of the same repository queued ahead of it. The report's dev flag on flagged packages uses the same rule.

**Network:** license data comes from deps.dev; with `--offline` (through `args`) every package comes back unknown.

## Internal packages

deps.dev knows only public packages, so a company's own libraries would all come back `UNKNOWN`. The analyzer reads the newest `depgraph` record of every repository in its history (`latestDepgraphs` and `packageCatalog` of [@holtkeeper/depgraph](../../depgraph/docs/README.md#internal-packages)): a package one of them defines as a versioned workspace, or a Go module (main modules carry no version; a path inside a defined module counts too), gets the verdict `internal` with `definedIn: 'forge:path'` and is not judged. `ignore` still wins. Nothing needs configuring: once the library repositories are analyzed by `depgraph` (the default `security-weekly` schedule does), their consumers see the packages as internal. The report counts them in an `internal` metric, lists them in an **Internal packages** section and shows `internal` in the license mix.

## Exceptions

An exception accepts one package whose licenses would not pass, with a reason people can check:

```ts
interface LicenseException {
  package: string // name, `*` wildcards allowed
  version?: string // exact version; absent: every version
  license?: string // the declared expression it accepts, e.g. `GPL-3.0-only`; absent: any
  reason: string
  approvedBy?: string
  expires?: string // last day it applies, YYYY-MM-DD
}
```

A package that is `denied`, `unlisted` or `unknown` (after `unknown: 'violation'`) gets the verdict `excepted` when an exception matches its name, version and declared licenses (joined with `AND`, compared without case); `exception` on the package holds the reason. `ignore`, dev-only packages under `devDependencies: 'ignore'` and internal packages are decided first, and allowed packages never become excepted. Expired exceptions are dropped when the run starts, so a scan after the date judges the package again.

## Data

```ts
interface LicensesData {
  tool: { name: 'osv-scanner'; version?: string }
  policy: {
    allow: string[]
    deny: string[]
    ignore: string[]
    review?: string[] // set only when not empty
    unknown?: 'warn' | 'violation' // set only for violation
    devDependencies?: 'check' | 'ignore' // set only for ignore
    exceptions?: LicenseException[] // the ones that applied on the day of the run
    requireProjectLicense?: boolean // set only when true
  }
  packages: {
    name: string
    version: string
    ecosystem: string // OSV name: npm, Go, PyPI, ...
    sources: string[] // lockfiles, relative to the checkout
    licenses: string[] // SPDX expressions; empty = nothing known
    groups?: string[] // dependency groups, e.g. dev; ['dev'] from the depgraph fallback
    verdict: 'allowed' | 'unknown' | 'unlisted' | 'denied' | 'ignored' | 'internal' | 'excepted'
    culprits?: string[] // licenses responsible for a verdict other than allowed
    definedIn?: string // internal packages: forge:path of the repository that defines it
    exception?: string // excepted packages: the reason of the exception
  }[]
  project?: { licenseFiles: string[] } // license files at the repository root; missing in older records
}
```

Verdicts are computed when the analysis runs and stored with the policy used, so a report shows what was decided then.

## Evaluating licenses

Expressions follow SPDX: `AND` binds tighter than `OR`, parentheses group, `WITH` attaches an exception, a trailing `+` means "or later". Operators are matched in any case (`mit or apache-2.0`), ids case-insensitively.

Every license gets one of four verdicts, ordered from best to worst: `allowed` > `unknown` > `unlisted` > `denied`.

- A single license: `denied` if it matches the deny list, else `unlisted` if it matches the review list, else `allowed` if it matches the allow list, else `unknown` for `LicenseRef-*`, else `unlisted`. Deny wins over review, review over allow. `X+` is allowed when `X` is allowed. `*` in a list entry matches within one id, so `GPL-*` matches `GPL-2.0+` and `GPL-3.0-only` but not `LGPL-2.1-only`.
- `A OR B` takes the best alternative (`MIT OR GPL-3.0` is allowed); `A AND B` takes the worst (`MIT AND GPL-3.0` is denied).
- `L WITH E` is judged as `L` unless the list contains the whole `L WITH E`, e.g. allow `GPL-2.0-only WITH Classpath-exception-2.0`.
- A list entry that is an expression (`MIT AND MPL-2.0`) matches that expression, or a parenthesized part of a larger one, regardless of operand order.
- `UNKNOWN`, `NOASSERTION`, `NONE`, `non-standard`, no license at all, and text that is not a valid expression are `unknown`.
- Several licenses declared for one package must all be acceptable; they are combined with `AND`.

`denied` and `unlisted` are violations; `unknown` is reported separately as a warning, or becomes `unlisted` with `unknown: 'violation'`. A matching [exception](#exceptions) turns any of them into `excepted`, which is not a violation.

## Presets

`licensePresets` set `allow`, `deny` and `unknown` together (keeping `ignore`); "permissive" below is `defaultAllow`, "source-available" is SSPL, BUSL, Elastic, Commons-Clause and CC-BY-NC.

| Id             | For                            | Allows                                     | Denies                                                                  | Unknown                                              |
| -------------- | ------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `commercial`   | products shipped to customers  | permissive                                 | GPL, AGPL, source-available (weak copyleft left for review)             | `warn`                                               |
| `no-copyleft`  | code that must stay permissive | permissive                                 | every copyleft (GPL, LGPL, MPL, EPL, CDDL, EUPL, ...), source-available | `violation`                                          |
| `open-source`  | projects under a free license  | permissive, weak copyleft, GPL, AGPL, EUPL | source-available                                                        | `warn`, and the repository needs a license file      |
| `internal`     | never distributed outside      | permissive, weak copyleft, GPL             | AGPL, source-available                                                  | `warn`                                               |
| `flag-missing` | on top of any policy           | (kept)                                     | (kept)                                                                  | `violation`, and the repository needs a license file |

## Report

- **Metrics**: packages, license violations (`better: 'down'`; `bad` when something is denied, else `warning`), unknown licenses (`better: 'down'`), distinct licenses — each with a delta against the previous record — and, with `requireProjectLicense`, repository license files (`warning` at 0).
- A missing repository license file under `requireProjectLicense` is the first issue of **Violations** (`project-license-missing`).
- **Violations**: an `issues` block, denied first (`bad`) then not allowed (`warning`); each names package, version, license, the offending licenses, its source files and dependency kind; tags are the ecosystem, the dependency groups and `new` when the package was not a violation in the previous analysis. With a previous record, a table of new and resolved violations follows (packages are compared by ecosystem and name, so a version bump is not "new").
- **License mix**: a donut chart of packages by license expression; the twelve largest slices, the rest as `Other`.
- **Unknown licenses**: a table of packages whose licenses are unknown, with what was declared.
- **Exceptions** (only when some package is `excepted`): package, version, license and the exception's reason; an `excepted` metric counts them.
- **Packages**: every package with version, ecosystem, license, verdict (toned), kind (tags) and source. Clients filter and sort tables; it is capped at 2000 rows.

## Metrics

`licensesMetrics(data)` is the kind's `metrics`, stored with every record as `LicensesMetrics`: `packages`, `verdicts` (packages per verdict, every verdict present with zero when none has it; records stored before `excepted` existed lack it, and readers count it as zero), `violations` (denied or not allowed), `missingProjectLicense` (the policy asked for a repository license file and there is none), `licenseFile` (`present`, `missing` or `not-required` when the policy does not ask), `licenses` (third-party packages per license expression, internal ones left out, `UNKNOWN` for none), `allowedLicenses` (the expressions of allowed packages) `flagged` (sorted `ecosystem:name` keys of the `denied`, `unlisted` and `unknown` packages), `flaggedDetails` (a `FlaggedPackage` per flagged key: name, ecosystem, flagged versions, declared licenses, worst verdict, culprits and whether every flagged version is dev-only by `isDevOnly`) and `byPackage` (`PackageLicenses` per `ecosystem:name`: its license expressions over all versions, sorted, and its worst verdict; absent on older records), which the fleet Libraries table reads instead of data. Fleet views add these up across repositories, list violations from `flaggedDetails` and compare `flagged` with an older record without reading data; `compareVerdict` orders verdicts worst first (denied, unlisted, unknown, excepted, allowed, internal, ignored) for every consumer; records stored before a field existed have their metrics computed from data when read.

## Tests

- `src/spdx.test.ts` — evaluation table for the default policy (OR/AND/WITH/`+`/unknowns/invalid text) and custom policies.
- `src/parse.test.ts` — parser on `test/osv-npm.json`, captured from osv-scanner 2.7.0 over a copy of `fixtures/npm` with one package marked `dev` (vulnerability details removed); tarball URL names and their merge with registry entries.
- `test/osv-scanner.test.ts` — `analyzeLicenses` on a temp copy of `fixtures/npm`, replaying the captured output, since the real scan needs deps.dev.
- `src/analyze.test.ts`, `src/report.test.ts` — command line, options (review list, dev-only dependencies and the depgraph fallback, exceptions and their expiry, applied end to end through `analyzeLicenses`), verdicts, metrics with deltas, new and resolved violations, sections.
