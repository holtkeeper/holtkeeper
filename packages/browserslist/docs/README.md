# @holtkeeper/browserslist

Keeps the browserslist database (`caniuse-lite`) current: runs `update-browserslist-db` through each repository's package manager and proposes the lockfile change as a merge request that shows which browsers the targets gained or lost.

## Analyzer

`browserslistAnalyzer` — kind `browserslist`, scope `repo`, `exclusive`, needs `forge`. `appliesTo` is `lockfileHasPackage('caniuse-lite')`, so schedules queue it only for repositories whose root lockfile resolves `caniuse-lite`; the default `browserslist-weekly` schedule of `@holtkeeper/managed-config` runs it on Tuesday nights across every group.

1. Checks out the default branch writable and finds the root lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`) that resolves `caniuse-lite`; without one the result is `not-applicable`.
2. Unless `dirs` is empty, installs from the frozen lockfile and resolves the browsers of each directory with the project's own `browserslist`.
3. Runs the update: `bunx`, `pnpm dlx`, `yarn dlx` (berry) or `npx --yes` (npm, yarn classic) `update-browserslist-db@latest`, or `command`.
4. No changed file: `up-to-date`. Otherwise installs again, resolves the browsers after, and commits the changed files (never `node_modules`) to `branch`, opening a merge request against the default branch or updating the open one. Commits are signed and pushed over git when the forge has a signing key.

Lifecycle scripts stay off (`--ignore-scripts`, `npm_config_ignore_scripts`, `YARN_ENABLE_SCRIPTS=false`) unless `allowInstallScripts`. A failing update is a result (`failed`, with the output tail), not a job failure; a failing install only leaves the browser lists unknown.

| Option                | Default                          | Meaning                                                          |
| --------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `command`             | by package manager               | Shell command that updates the database                          |
| `dirs`                | `['.']`                          | Directories whose browsers are compared; `[]` skips the installs |
| `allowInstallScripts` | `false`                          | Run dependency lifecycle scripts                                 |
| `timeoutMinutes`      | `15`                             | Per command                                                      |
| `branch`              | `holtkeeper/browserslist`        | Branch of the merge request                                      |
| `labels`              | `['holtkeeper', 'dependencies']` |                                                                  |
| `dryRun`              | `false`                          | Update and report, publish nothing                               |

## Data and report

`BrowserslistData`: `status` (`not-applicable`, `up-to-date`, `updated`, `failed`), `lockfile`, `packageManager`, `caniuse-lite` versions `before`/`after`, `targets` (browsers per directory before and after), changed `files`, `mergeRequest`, `dryRun`, `output`. `browserslistAnalysis` renders the status, the database version, a table of added and removed browsers and the command output. `targetChanges(targets)` gives the added and removed browsers; `caniuseVersions(text)` reads the versions from lockfile text.
