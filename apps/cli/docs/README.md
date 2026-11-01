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
holtkeeper explain work:games/app-x
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
holtkeeper audit ./games/app-x --fix --allowlist allowlist.json --trait ssr=false
```

Needs `osv-scanner` on `PATH`; fixing needs the project's package manager or `go`.

### `release <action>`

The release assistant (see [@holtkeeper/release](../../../packages/release/docs/README.md)) against the config's forges. Settings are the `releases` setting from the config's store when the config has a `server` section, with `--preset <ids>` (comma-separated) and a JSON `--settings <file>` laid over it.

- `status [--repo <forge>:<path> | --group <name>]` — one tab-separated line per repository: path, stage, latest → next version, commits ahead and unreleased, open candidate, acceptance, deploy state (`--json` for the rows).
- `plan --repo <forge>:<path> [--step propose|version] [--version x.y.z]` — the plan of the step that waits (or the given one): range, suggested version with reasons, gates and the text; exits 2 while a gate fails.
- `propose --repo …` — opens or updates the release candidate merge request.
- `accept --repo … [--note <text>]` — accepts the target branch head for release in the store, like the panel; needs a store with `kv`. Use it from CI or scripts to tie acceptance to any process.
- `version --repo … [--version x.y.z]` — creates the version (tag, release, optional changelog file).
- `deploy --repo … --env <name> [--tag <tag>] [--redeploy]` — starts the deploy job of an environment for the version (the latest by default).

`--force` overrides failing pipeline, freeze, blocker and acceptance gates (and the deploy order); `--dry-run` (or `dryRun` in the config) reports without changing anything.

### `users <action>`

Manages accounts of `users` sign-in (see [@holtkeeper/auth-users](../../../packages/auth-users/docs/README.md)) directly in the config's store, without delegation checks: whoever can read the config and its secrets is an operator. Every change is logged with actor `cli`. `<user>` is an id, an email or a name that only one user has.

- `list` — one tab-separated line per user: id, name, email, `admin` or grant count, state (`--json` for the stored users).
- `add <name> [--email <address>] [--admin]` — an enabled user without passkeys; `--admin` grants every action on everything, otherwise no grants (add them in the web UI).
- `login-link <user> [--ttl 15m]` — a single-use `${publicUrl}/auth/users/link/<token>/login`. Opening it signs the holder in without a passkey and redirects to `/`; it is how an AI agent gets a browser session to drive the web UI. Treat it like a password until it expires.
- `enroll-link <user>` / `recover-link <user>` (`--ttl`, default `72h`) — the web UI's passkey registration link, as an admin would issue it.

Links need `server.publicUrl`. In Kubernetes run it in a web pod: `kubectl exec deploy/<release>-web -- holtkeeper users login-link Claude -c /app/config/holtkeeper.config.ts`.

### `serve`

Starts the web server described by the config's `server` section (see [@holtkeeper/server](../../server/docs/README.md)) and runs until `SIGINT`/`SIGTERM`, then drains and exits 0.

- `--role web|worker|scheduler|all` (or `HOLTKEEPER_ROLE`; default `all`; combine with commas, e.g. `web,scheduler`).
- `--concurrency <n>` (`HOLTKEEPER_CONCURRENCY`): jobs this worker runs at once.
- `--max-jobs <n>` (`HOLTKEEPER_MAX_JOBS`): exit 0 after running `n` jobs, for a fresh container or pod per job.
- `--drain-timeout <time>` (`HOLTKEEPER_DRAIN_TIMEOUT`, default `30s`): how long running jobs may finish on shutdown before they are requeued.

See [docs/deployment.md](../../../docs/deployment.md).
