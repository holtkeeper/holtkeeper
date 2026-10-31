# @holtkeeper/warmup

The `warmup` analyzer and analysis kind: runs a command of your choosing in a checkout of a pushed commit, so build caches (Turborepo remote cache, Nx Cloud, Gradle, ...) are already warm when people and CI build the same commit. It records the exit code, how long the command took and the tail of its output.

## Public API

- `warmupAnalyzer` — `Analyzer<WarmupData, WarmupOptions>`, kind `warmup`, scope `repo`, needs `checkout`. `createWarmupAnalyzer({ now? })` makes one with another clock. Options (`warmupOptionsSchema`):
  - `command: string` (`--command`) — required: run as `sh -c <command>` through the job's runner, so in its sandbox and with the repository's toolchain.
  - `cwd: string` (`--cwd`) — default `.`: a directory inside the checkout.
  - `env: Record<string, string>` — extra environment of the command. Values are stored with the job and shown in the panel: put secrets in as [egress secret](../../../apps/server/docs/README.md#egress-rules) placeholders, never as plain values.
  - `timeoutMinutes: number` (`--timeout-minutes`) — stops the command; the job's own `jobs.timeoutMinutes` still applies.
  - `outputLines: number` — default 200: lines of output kept in the record.
  - `branch: string` — set by push triggers.
- `warmupAnalysis` — the `AnalysisKind` (`schema: warmupDataSchema`); `warmupReport(data, { previous?, ref? })` builds the report: status, duration against the previous run, command and output tail.

The panel's **Build warm-up** page lists every run with its outcome, branch, duration and links to the job log and the report; `summarize` reports `status`, `duration` and, for pushes, `branch`.

A failing command is a result, not a job failure: the job succeeds and the record shows `failed` (or `timed out`) with the exit code, so a broken build is not retried over and over. The last 40 lines also go to the job log.

## Warming a Turborepo cache on every push

1. **Command.** Settings → Analyzers → `warmup` for the repository (scoped setting `analyzers.warmup`):

   ```json
   {
     "command": "yarn install --immutable && yarn all",
     "env": { "TURBO_TEAMID": "my-team", "TURBO_TOKEN": "<placeholder of the proxy secret>" }
   }
   ```

2. **Secret.** Credentials → New credential → kind **Proxy secret**: URL = the cache's API URL (`apiurl` of `.turbo/config.json`, `http://` when the cache is plain HTTP), secret = the real token. Copy its placeholder into `TURBO_TOKEN`. Turborepo sends `Authorization: Bearer <placeholder>`; the egress proxy swaps in the token for that host only.
3. **Trigger.** Automation → Triggers → **Branch push**: analyzer `warmup`, branches (e.g. `main`, `release/*`; none for every branch), optionally groups. Pushes arrive by webhook (registered hooks include push events) or by polling.
4. **Runtime.** The egress proxy must be on (`jobs.execution.egress` with `mode: 'mise'` or `'container'`, and `server.egress` so the proxy reads rules from the server; see [docs/deployment.md](../../../docs/deployment.md#egress-proxy)). In `container` mode the build needs the network for its whole run: set `network: full` for the repository in the scoped `toolchain` setting.

A newer push to the same branch cancels the warm-up still queued for the older commit; one analyzer never runs twice at once on one repository.
