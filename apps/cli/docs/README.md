# @holtkeeper/cli

The `holtkeeper` command: the server's entrypoint. It starts the server (`serve`, the command of the container image and the Helm chart) and handles operator account tasks (`users`). Everything else happens in the web panel, or over MCP for AI agents. It runs from source with Bun.

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

### `serve`

Starts the web server described by the config's `server` section (see [@holtkeeper/server](../../server/docs/README.md)) and runs until `SIGINT`/`SIGTERM`, then drains and exits 0.

- `--role web|worker|scheduler|all` (or `HOLTKEEPER_ROLE`; default `all`; combine with commas, e.g. `web,scheduler`).
- `--concurrency <n>` (`HOLTKEEPER_CONCURRENCY`): jobs this worker runs at once.
- `--claim-delay <time>` (`HOLTKEEPER_CLAIM_DELAY`): take only jobs queued at least this long, e.g. `15s`, so workers without a delay get new jobs first and this one takes the overflow.
- `--pool <pools>` (`HOLTKEEPER_WORKER_POOL`): worker pools this worker serves, comma-separated (default `default`). A worker claims only jobs of analyzers in its pools: `--pool write` makes a dedicated [write task](../../../packages/write-task/docs/README.md) worker, `--pool default,write` a single process that runs everything.
- `--max-jobs <n>` (`HOLTKEEPER_MAX_JOBS`): exit 0 after running `n` jobs, for a fresh container or pod per job.
- `--drain-timeout <time>` (`HOLTKEEPER_DRAIN_TIMEOUT`, default `30s`): how long running jobs may finish on shutdown before they are requeued.

See [docs/deployment.md](../../../docs/deployment.md).
