# Worker image

The sandbox `@holtkeeper/exec-container` runs job commands in. `debian:stable-slim` with `git`, `ca-certificates`, `curl`, [mise](https://mise.jdx.dev), `osv-scanner` and `gitleaks` — no language runtimes. Node, Go, Python, ... are installed by mise on demand into the cache volume and shared between jobs.

| Tool        | Version      | Build argument        |
| ----------- | ------------ | --------------------- |
| mise        | `2026.10.13` | `MISE_VERSION`        |
| osv-scanner | `2.7.0`      | `OSV_SCANNER_VERSION` |
| gitleaks    | `8.30.1`     | `GITLEAKS_VERSION`    |

Scanner versions match the repository's `mise.toml`; bump both together. Every download is checked against the checksum file of its release.

## Build

```sh
docker build -t holtkeeper-worker:latest docker/worker
# another architecture
docker buildx build --platform linux/amd64 -t holtkeeper-worker:latest docker/worker
```

Then set `jobs.execution: { mode: 'container' }` (the default image is `holtkeeper-worker:latest`; `image` or the scoped `toolchain` setting picks another). amd64 and arm64 are supported. The image is about 440 MB unpacked; most of it is the mise binary.

## Environment

- User `holtkeeper`, uid/gid `10001`, `HOME=/tmp` (the root filesystem is read-only at run time).
- `MISE_DATA_DIR=/mise`, `MISE_CACHE_DIR=/mise/cache`, `MISE_STATE_DIR=/mise/state` — the named volume `holtkeeper-mise-cache`. `/mise` is owned by 10001 in the image, so docker initializes a fresh volume with that owner.
- `MISE_YES=1`, `MISE_DISABLE_UPDATE_WARNING=1`.
- `git config --system safe.directory '*'`, because checkouts are bind mounts owned by the host user.

## Security model

What a job container gets from `containerRunner`:

- **One container per job**, removed when the job ends. Commands are `docker exec`s into it; nothing is shared with other jobs except the tool cache.
- **No network** by default (`network: 'install'`): tools are installed in a separate short-lived container that has network but no checkout, so repository code (install scripts, mise config, build files) never runs while the network is open. `network: 'none'` also closes the install step (tools must be cached); `full` opens the job container too.
- **Read-only root filesystem**; writable are only `/tmp` (tmpfs, size-limited), the checkout and the cache volume.
- **No privileges**: non-root user, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--init` for signal handling and zombie reaping.
- **Limits**: CPUs, memory and process count (`jobs.execution.limits`).
- **Secrets stay out**: no environment is baked into the image or the container; variables are passed per command and through the engine CLI's environment, never in argv. Host variables reach a command only when allowlisted. Git credentials are used by clones on the host; the container never sees them.
- **Repository config is not trusted**: `MISE_IGNORED_CONFIG_PATHS` covers the mounts, so a repository's `mise.toml` cannot set environment or run hooks; tool versions come from detection plus the scoped setting.

Not covered: the cache volume is writable by every job, so a malicious job could tamper with cached tools used by later jobs (use separate volumes per trust level, or `network: 'none'` with a pre-filled read-only cache, if that matters). Kernel isolation is that of the container engine; use a rootless engine or a VM-backed runtime (gVisor, Kata, OrbStack/Docker Desktop VMs) for stronger boundaries. Tools that compile from source (some Ruby or Python versions) need a compiler the image does not have.
