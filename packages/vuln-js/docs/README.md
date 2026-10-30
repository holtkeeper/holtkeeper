# @holtkeeper/vuln-js

A `Fixer` for JavaScript projects. It removes vulnerable npm packages by editing the `package.json` next to a lockfile and regenerating that lockfile with the project's own package manager. It is the fallback for lockfiles `osv-scanner fix` cannot handle (bun, pnpm, yarn) and a second chance for npm `package-lock.json`.

## Public API

- `jsFixer({ runner? }): Fixer` — fixer named `js`. `supports(source)` is true for `bun.lock`, `pnpm-lock.yaml`, `yarn.lock` and `package-lock.json`. `runner` defaults to `localRunner`.
- `planManifestEdits(manifest, findings, manager)` — pure: returns the edited manifest, the fixed finding ids and notes.
- `detectPackageManager(kind, dir, packageManagerField)` and `lockfileUpdateCommand(manager)` — package-manager detection and the command that regenerates its lockfile.

## How a fix works

1. The lockfile decides the package manager; its directory is the project root.
2. For every `npm` finding the target is `fixedVersions[0]`. Findings without a fix, or whose fix is not newer than the installed version, are skipped with a note. Several findings for the same package use the highest target.
3. A **direct** dependency (`dependencies`, `devDependencies`, `optionalDependencies`) whose range still admits the vulnerable version gets `^<target>`.
4. A **transitive** package gets an override `^<target>`. An existing override for the same key or plain name is replaced only when it still admits the vulnerable version; otherwise it is left alone.
5. The lockfile is regenerated without lifecycle scripts. `changedFiles` comes from comparing file hashes before and after. If the package manager fails, `package.json` and the lockfile are restored and the `CommandError` is rethrown.

## Per package manager

| Manager      | Override field   | Override key        | Lockfile command                                   |
| ------------ | ---------------- | ------------------- | -------------------------------------------------- |
| npm          | `overrides`      | `qs@>=6.7.0 <6.7.3` | `npm install --package-lock-only --ignore-scripts` |
| bun          | `overrides`      | `qs@>=6.7.0 <6.7.3` | `bun install --lockfile-only --ignore-scripts`     |
| pnpm         | `pnpm.overrides` | `qs@>=6.7.0 <6.7.3` | `pnpm install --lockfile-only --ignore-scripts`    |
| yarn berry   | `resolutions`    | `qs`                | `yarn install --mode=update-lockfile`              |
| yarn classic | `resolutions`    | `qs`                | `yarn install --ignore-scripts`                    |

npm, pnpm and Bun 1.4 match override keys with a semver range (checked against npm 11, pnpm 10 and Bun 1.4.4), so the key covers only the vulnerable versions `>=<lowest vulnerable> <target>`. With selector keys, findings are grouped per major line, so a fix on `qs@2` does not pull `qs@6` users along. Yarn classic only matches names and globs, and berry matches exact descriptors, not ranges, so yarn gets one plain-name resolution per package that moves every copy.

Yarn berry is chosen when `.yarnrc.yml` is in the project directory or `packageManager` is `yarn@2` or later; otherwise yarn classic.

## Limitations

- When the vulnerable copy is transitive but the package is also a direct dependency whose range already excludes it, nothing is overridden (npm rejects overrides that conflict with direct dependencies). A note explains it.
- Non-semver ranges (`file:`, `workspace:`, `git`, URLs, aliases, dist-tags) and nested npm override objects are skipped with a note.
- Only the `package.json` next to the lockfile is edited. Workspace members' manifests are not touched, and overrides kept in `pnpm-workspace.yaml` are neither read nor merged.
- Yarn classic has no lockfile-only mode, so it installs `node_modules` (scripts still disabled).
- The package manager needs registry access. The rescan decides whether a finding is really gone.
