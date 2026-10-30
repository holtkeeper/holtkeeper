# @holtkeeper/cli

The `holtkeeper` command. It runs from source with Bun.

```sh
bunx holtkeeper <command> [options]
```

## Options

| Option                | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `-c, --config <file>` | Config file. Default: `holtkeeper.config.ts` in the current directory. |
| `-h, --help`          | Show usage.                                                            |

## Commands

### `validate-config`

Loads and validates the config, prints a short summary and exits with `0`. On errors, prints every problem with its path and exits with `1`. Does not need secrets.

### `explain <forge>:<path>`

Prints, as JSON, what applies to a repository: its groups, merged traits and every plugin with its final options.

```sh
holtkeeper explain work:games/slots-x
```

Matching is done against the config only; the forge is not contacted.

### `audit [dir]`

Scans a checkout (default: the current directory) with osv-scanner and prints findings that are not allowlisted. Exits with `1` while any remain, `0` otherwise.

| Option                | Description                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--fix`               | Try to fix findings, then rescan. Fixers run in order: `osv-scanner fix` (npm, Maven), then the JavaScript fixer (bun, pnpm, yarn, npm leftovers), then the Go fixer. Files are changed in place. |
| `--allowlist <file>`  | JSON array of allowlist entries (see [@holtkeeper/vuln](../../../packages/vuln/docs/README.md#allowlist)).                                                                                        |
| `--trait <key=value>` | Repository trait for conditional entries, repeatable. `true`, `false` and numbers are typed.                                                                                                      |
| `--json`              | Print the full report as JSON.                                                                                                                                                                    |

```sh
holtkeeper audit ./games/slots-x --fix --allowlist allowlist.json --trait ssr=false
```

Needs `osv-scanner` on `PATH`; fixing needs the project's package manager or `go`.

### `serve`

Starts the web server described by the config's `server` section (see [@holtkeeper/server](../../server/docs/README.md)) and runs until `SIGINT`/`SIGTERM`, then drains and exits 0.

- `--role web|worker|scheduler|all` (or `HOLTKEEPER_ROLE`; default `all`; combine with commas, e.g. `web,scheduler`).
- `--concurrency <n>` (`HOLTKEEPER_CONCURRENCY`): jobs this worker runs at once.
- `--max-jobs <n>` (`HOLTKEEPER_MAX_JOBS`): exit 0 after running `n` jobs, for a fresh container or pod per job.
- `--drain-timeout <time>` (`HOLTKEEPER_DRAIN_TIMEOUT`, default `30s`): how long running jobs may finish on shutdown before they are requeued.

See [docs/deployment.md](../../../docs/deployment.md).
