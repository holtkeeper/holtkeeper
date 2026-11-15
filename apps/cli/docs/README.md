# @holtkeeper/cli

The `holtkeeper` command: the server's entrypoint. It starts the server (`serve`, the command of the container image and the Helm chart), handles operator account tasks (`users`), checks reported secrets against OpenBao or Vault (`secrets`) and measures Code Review (`review-eval`). Everything else happens in the web panel, or over MCP for AI agents. It runs from source with Bun.

```sh
bunx holtkeeper <command> [options]
```

## Options

| Option                | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `-c, --config <file>` | Config file. Default: `holtkeeper.config.ts` in the current directory. |
| `-h, --help`          | Show usage.                                                            |

## Commands

### `users <action>`

Manages accounts of `users` sign-in (see [@holtkeeper/auth-users](../../../packages/auth-users/docs/README.md)) directly in the config's store, without delegation checks: whoever can read the config and its secrets is an operator. Every change is logged with actor `cli`. `<user>` is an id, an email or a name that only one user has.

- `list` — one tab-separated line per user: id, name, email, `admin` or grant count, state (`--json` for the stored users).
- `add <name> [--email <address>] [--admin]` — an enabled user without passkeys; `--admin` grants every action on everything, otherwise no grants (add them in the web UI).
- `login-link <user> [--ttl 15m]` — a single-use `${publicUrl}/auth/users/link/<token>/login`. Opening it signs the holder in without a passkey and redirects to `/`; it is how an AI agent gets a browser session to drive the web UI. Treat it like a password until it expires.
- `enroll-link <user>` / `recover-link <user>` (`--ttl`, default `72h`) — the web UI's passkey registration link, as an admin would issue it.

Links need `server.publicUrl`. In Kubernetes run it in a web pod: `kubectl exec deploy/<release>-web -- holtkeeper users login-link Claude -c /app/config/holtkeeper.config.ts`.

### `secrets <action>`

Helpers for [secret reports](../../../packages/secret-reports/docs/README.md). Values never leave the process.

- `fingerprint` — prints the fingerprint of the value on standard input (one trailing newline dropped): the first 16 hex characters of its SHA-256, as reports carry it. `printf %s "$WIDGET_API_KEY" | holtkeeper secrets fingerprint`.
- `match <fingerprint...> --address <url> --mount <mount> [--prefix <path>] [--namespace <ns>] [--json]` — walks the latest version of every secret of an OpenBao or Vault KV v2 engine (`matchKvSecrets`) and prints one tab-separated line per field whose value has one of the fingerprints: fingerprint, `<mount>/<path>`, field, version. The token comes from `BAO_TOKEN` or `VAULT_TOKEN`; `--address` defaults to `BAO_ADDR` or `VAULT_ADDR`. Folders the token may not list or read are skipped. Exit code 0 when something matched, 1 when nothing did.

### `review-eval`

Measures Code Review in one command: precision and recall of the [golden set](../../../packages/review/docs/README.md#measuring-quality) reviewed by a real model, then the acceptance of Holtkeeper's review comments on merged merge requests of the config's store, grouped by category.

```sh
ANTHROPIC_API_KEY=sk-... bunx holtkeeper review-eval --repeat 3
```

- The golden half reviews every invented case in a temporary checkout with the real pipeline and prints precision, recall, f1, clean changes that still drew a comment, cost, and the missed problems and false positives. The model comes from `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL` for an Anthropic-compatible endpoint); the cases cost real tokens. `--case <id>` limits it (repeatable), `--repeat <n>` reviews each case n times, `--concurrency <n>` sets how many run at once (default 3).
- The acceptance half reads the outcomes stored when merge requests were merged (see [@holtkeeper/server](../../server/docs/README.md#review-learnings)). `--by category|severity|model|promptVersion|source` groups it, `--days <n>` limits it to comments updated in the last n days (default 90). It is skipped with a note when the config file does not exist.
- `--no-golden` prints only the acceptance, `--no-acceptance` only the golden set, `--json` prints both as JSON. The exit code is 1 when a golden run failed.

### `serve`

Starts the web server described by the config's `server` section (see [@holtkeeper/server](../../server/docs/README.md)) and runs until `SIGINT`/`SIGTERM`, then drains and exits 0.

- `--role web|worker|scheduler|all` (or `HOLTKEEPER_ROLE`; default `all`; combine with commas, e.g. `web,scheduler`).
- `--concurrency <n>` (`HOLTKEEPER_CONCURRENCY`): jobs this worker runs at once.
- `--claim-delay <time>` (`HOLTKEEPER_CLAIM_DELAY`): take only jobs queued at least this long, e.g. `15s`, so workers without a delay get new jobs first and this one takes the overflow.
- `--pool <pools>` (`HOLTKEEPER_WORKER_POOL`): worker pools this worker serves, comma-separated (default `default`). A worker claims only jobs of analyzers in its pools: `--pool write` makes a dedicated [write task](../../../packages/write-task/docs/README.md) worker, `--pool default,write` a single process that runs everything.
- `--max-jobs <n>` (`HOLTKEEPER_MAX_JOBS`): exit 0 after running `n` jobs, for a fresh container or pod per job.
- `--drain-timeout <time>` (`HOLTKEEPER_DRAIN_TIMEOUT`, default `30s`): how long running jobs may finish on shutdown before they are requeued.

See [docs/deployment.md](../../../docs/deployment.md).
