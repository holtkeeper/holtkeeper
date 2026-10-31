# @holtkeeper/exec-container

`CommandRunner`s that run commands with a repository's toolchain: in a sandboxed container (docker or podman), or on the host through mise. Both are `ManagedRunner`s — `start()` before the first `run`, `stop()` when done.

```ts
import { localRunner } from '@holtkeeper/exec'
import { containerRunner, networksFor } from '@holtkeeper/exec-container'

const runner = containerRunner({
  image: 'holtkeeper-worker:latest', // docker/worker
  workspace: { hostDir: checkout.dir }, // mounted at /workspace
  toolchain, // from @holtkeeper/toolchain
  ...networksFor('install'), // { network: 'none', installNetwork: 'bridge' }
  limits: { cpus: 2, memory: '4g', pids: 1024 },
  envAllowlist: ['HTTPS_PROXY'],
  hostRunner: localRunner,
})
await runner.start()
await runner.run(['pnpm', 'install', '--offline'], { cwd: join(checkout.dir, 'web') })
await runner.stop()
```

## containerRunner

`start()`:

1. When the toolchain has tools: `docker run --rm … image mise install node@20 pnpm@9.12.0` in a short-lived container with network `installNetwork` (default `bridge`) and **without** the checkout, so repository code never runs while the network is open. Tools land in the named volume `cacheVolume` (default `holtkeeper-mise-cache`, mounted at `/mise`) and are reused by later jobs.
2. The job container: `docker run --detach --rm --init --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=2g --security-opt no-new-privileges --cap-drop ALL --user 10001:10001 --network none --cpus 2 --memory 4g --pids-limit 1024`, the cache volume, the checkout at `/workspace` (read-write), `extraMounts` (e.g. read-only extra checkouts), `sleep infinity`. A failed start throws and can be retried.

`run(command, { cwd, env, timeoutMs, signal })`:

- `cwd` is mapped from the host to the container through the mounts (the most specific wins); a directory outside every mount is rejected.
- The command runs as `docker exec --workdir <mapped> -e NAME… <id> setsid -w sh -c '<record pid>' mise exec <tools> -- <command>`. Without tools there is no `mise exec` prefix.
- Environment, per command only: allowlisted host variables (`envAllowlist`, read from `hostEnv`), `MISE_IGNORED_CONFIG_PATHS` (the mount points, so a repository's `mise.toml` cannot run code — versions come from the toolchain), `options.env`, then the run's `env` (`undefined` removes). Values travel through the engine CLI's environment (`-e NAME`), never through argv.
- Any exit code is a result. Engine failures (no such container, daemon errors) reject.
- On timeout or abort the command's whole process group is killed inside the container; if that fails, the container is killed (later runs then reject until `start` is called again). The engine CLI gets a 10 s grace period on top of `timeoutMs`.

`stop()` removes the container (`docker rm --force`); safe to call repeatedly or without `start`.

`engine` defaults to `detectEngine()`: docker when installed, else podman. The arguments are the same for both.

## localMiseRunner

`localMiseRunner({ toolchain, hostRunner, env?, envAllowlist?, hostEnv?, ignoreConfigIn? })` runs commands on the host, e.g. inside a worker pod or for development without containers: `start()` runs `mise install <specs>` once, `run()` prefixes commands with `mise exec <tools> --`. `ignoreConfigIn` (e.g. the checkout) sets `MISE_IGNORED_CONFIG_PATHS`.

Environment, for `mise install` and every command: the variables of `hostEnv` (default `Bun.env`, i.e. what `hostRunner` would inherit) matched by `defaultLocalEnvAllowlist` or `envAllowlist`, then `MISE_IGNORED_CONFIG_PATHS`, `options.env`, then the run's `env`. Every other host variable is passed as `undefined`, which the `CommandRunner` contract defines as "remove", so no change to `@holtkeeper/exec` is needed and any runner that honours the contract drops it. `defaultLocalEnvAllowlist` is `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`/`TMP`/`TEMP`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `TERM`, `XDG_*`, `MISE_*`, the `HTTP(S)_PROXY`/`NO_PROXY` pairs, `SSL_CERT_FILE`, `SSL_CERT_DIR` and `NODE_EXTRA_CA_CERTS`. A trailing `*` matches a prefix but never a secret-looking name (`TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `…_KEY`), so `MISE_GITHUB_TOKEN` is dropped; list such a variable by its exact name to pass it. `HOLTKEEPER_*` never passes, even when listed. Variables the worker image sets for its own process (e.g. `NODE_ENV=production`) are not inherited either.

Limits — the filter keeps secrets out of a command's environment, not out of its reach. Commands run as the worker's uid in the worker's mount and PID namespace, so a hostile command can still:

- read `/proc/<worker pid>/environ` (same uid; deleting variables from `process.env` does not change it) and the read-only config file;
- read other jobs' checkouts and the mirror cache under `/workspace`, and connect to whatever the worker's network allows (database, object store).

Use `containerRunner`, or in Kubernetes the measures in [docs/deployment.md](../../../docs/deployment.md#isolation-one-job-per-worker-pod), for repositories you do not trust.

## Testing

Unit tests assert the generated engine arguments with `createFakeRunner`. `test/container.test.ts` runs `node --version` for an `.nvmrc` fixture in a real container and checks the sandbox (non-root, no network, read-only root, timeouts); it is opt-in:

```sh
docker build -t holtkeeper-worker:dev docker/worker
HOLTKEEPER_DOCKER_TESTS=1 bun test packages/exec-container/test
```

`HOLTKEEPER_WORKER_IMAGE` picks another image. The test uses the shared cache volume.

## Tool cache size

`miseCacheSize(options)` and `miseCacheStorage(options)` (a `StorageProvider` of the `@holtkeeper/artifacts` shape) report how much mise's installed tools take:

- `{ mode: 'container', engine?, volume?, image?, hostRunner }` — the cache volume (default `holtkeeper-mise-cache`): `docker system df -v --format json`, falling back to `du -sk` in a throwaway `image` container (default `alpine`, no network). `clear()` removes the volume; the engine refuses while a job uses it.
- `{ mode: 'host', dataDir? }` — `MISE_DATA_DIR` (default `~/.local/share/mise`); not clearable, the cache is shared with people's own mise.

A missing volume or directory reports `available: false`.

## Egress proxy

`egressEnvironment(proxy, options?)` turns an `EgressProxy` (`{ url, caFile?, noProxy? }`) into what a runner adds to its commands, so their HTTP(S) traffic goes through a forward proxy — for example one that adds registry tokens, so jobs install private packages without holding them ([docker/egress-proxy](../../../docker/egress-proxy/README.md) is one; any proxy speaking HTTP `CONNECT` works).

- `env`: `HTTP_PROXY`/`HTTPS_PROXY` (both cases), `YARN_HTTP_PROXY`/`YARN_HTTPS_PROXY`, `NO_PROXY` (`localhost`, `127.0.0.1`, `::1` and `noProxy`).
- With `caFile`: `NODE_EXTRA_CA_CERTS` (the CA alone; Node adds it to its own roots), and `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE` pointing at the system trust store (the first of `systemBundles` that exists) with the CA appended, so tools that only read a whole store still verify every other host. Both files are written once per CA content to `holtkeeper-egress-<hash>/` in `dir` (default the temp directory). Without a system store only Node-based tools trust the CA. Yarn gets the CA through `NODE_EXTRA_CA_CERTS` only: its CA setting is `caFilePath` in Yarn 2–3 and `httpsCaFilePath` in Yarn 4, and each version rejects the other name, so no `YARN_*` CA variable works for all.
- `mounts`: with `containerDir`, that directory mounted read-only, and the variables point inside it.

`localMiseRunner` and `containerRunner` take the result through their `env` (and `extraMounts`); `createRunner` of `@holtkeeper/jobs` does this for `jobs.execution.egress`. The job container must be able to reach the proxy: with `container` execution that means network `full`.

## Limitations

- A command missing inside the container is a non-zero result, not a rejection as with `localRunner`.
- Mount paths containing commas are rejected (`--mount` syntax).
- With `network: 'none'` the job cannot download dependencies; analyzers that install packages need `install` with an offline-capable step or `full`.
- Bind-mounted checkouts must be writable by the container user; on Linux run the server as uid 10001 or set `user`.
