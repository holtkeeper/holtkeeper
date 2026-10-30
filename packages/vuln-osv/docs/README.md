# @holtkeeper/vuln-osv

[OSV-Scanner](https://google.github.io/osv-scanner/) behind the `@holtkeeper/vuln` contracts: a `Scanner` for every ecosystem osv-scanner reads, and a `Fixer` that uses its guided remediation where it is available.

Requires the `osv-scanner` binary (pinned in the repository's `mise.toml`; tested with 2.7.0).

## osvScanner

```ts
osvScanner({ runner?, binary = 'osv-scanner', args = [] })
```

Runs `osv-scanner scan source --recursive --allow-no-lockfiles --format json <dir>`. Only lockfiles and manifests are read; dependencies are not installed. Files ignored by `.gitignore` are skipped. Exit code `1` means "vulnerabilities found" and is not an error. `args` passes extra flags, e.g. `['--x-exclude', 'g:**/examples/**']` or `['--offline-vulnerabilities']`.

osv-scanner treats an npm package without a `resolved` URL as local and never checks it, so a lockfile written with `omit-lockfile-registry-resolved` would scan as clean. For the duration of the scan, every `package-lock.json` and `npm-shrinkwrap.json` outside `node_modules` gets a registry `resolved` URL for such packages (workspace paths, links and `file:` versions excluded); each file is restored byte for byte afterwards, also when the scan fails.

Mapping to `Finding`:

- one finding per osv-scanner advisory group and package; the GHSA id is primary when the group has one, the rest become `aliases`;
- `severity` from the group's highest CVSS score, falling back to the GHSA severity label;
- `fixedVersions` from the affected ranges that contain the installed version, lowest first. When versions are not semver (Maven, PyPI, ...) they cannot be compared here, so every fixed version of the package is listed;
- `source` relative to the scanned directory.

The JSON is validated with `osvScanOutputSchema` so format changes fail loudly. `parseScanOutput(json, dir)` is exported for reuse.

## osvFixer

```ts
osvFixer({ runner?, binary = 'osv-scanner', upgrade? })
```

Supports `package-lock.json` and `pom.xml`. Strategy per source:

| Source                                             | Strategy   | Changes                                                   |
| -------------------------------------------------- | ---------- | --------------------------------------------------------- |
| `package-lock.json` with `package.json` next to it | `relax`    | dependency ranges in `package.json`, regenerated lockfile |
| `package-lock.json` alone                          | `in-place` | lockfile only, within existing ranges                     |
| `pom.xml`                                          | `override` | dependency management overrides                           |

It always passes `--no-introduce` (no patch may add a new advisory) and `--vulns <id>` for each finding it was given, so allowlisted findings are never touched. `fixed` lists the requested findings osv-scanner reports as patched, and only when a file actually changed; unactionable advisories become notes.

`upgrade` maps to `--upgrade-config`. When omitted, osv-scanner's default (`major`) applies. In osv-scanner 2.7, `minor` and `patch` marked every advisory of the npm fixture as unactionable — including ones a minor bump fixes — so a restriction is opt-in.

Whatever this fixer leaves unfixed goes to the next fixer in the chain (for npm that is `@holtkeeper/vuln-js`).

## Caveats

- `osv-scanner fix` may run the package manager and follow registries configured in the project. Use it on trusted checkouts only, and in an isolated runner once one exists.
- Vulnerability data comes from the OSV API, so scans need network access unless offline databases are downloaded.
