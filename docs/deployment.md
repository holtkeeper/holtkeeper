# Deployment

Holtkeeper runs as one image in every setting. A process gets its work from its role:

```sh
holtkeeper serve --role web|worker|scheduler|all   # also HOLTKEEPER_ROLE; default all
```

| Role        | HTTP                                  | Worker | Scheduler duties (under the leader lease) |
| ----------- | ------------------------------------- | ------ | ----------------------------------------- |
| `web`       | API, UI, webhooks, probes, `/metrics` | no     | no                                        |
| `worker`    | probes and `/metrics` only            | yes    | no                                        |
| `scheduler` | probes and `/metrics` only            | no     | yes                                       |
| `all`       | everything                            | yes    | yes                                       |

Roles combine with commas: `--role web,scheduler` is the API plus the scheduler, which is what the Helm chart runs in its web pods by default.

Scheduler duties are schedules, credential rotation, artifact retention and audit retention. Every process with the scheduler role contends for a lease in the store (`kv.acquireLease`, key `leader:scheduler`, TTL 30 s, renewed every 10 s); only the holder runs the duties. When the holder dies, another process takes over within one TTL. When a renewal fails (store unreachable), the holder stops its duties at once, so two leaders do not overlap past one lease.

Worker flags:

| Flag                     | Environment                | Meaning                                                                     |
| ------------------------ | -------------------------- | --------------------------------------------------------------------------- |
| `--concurrency <n>`      | `HOLTKEEPER_CONCURRENCY`   | Jobs at once in this process (default `jobs.concurrency`)                   |
| `--max-jobs <n>`         | `HOLTKEEPER_MAX_JOBS`      | Claim `n` jobs, finish them, exit 0: a fresh process or pod per job         |
| `--drain-timeout <time>` | `HOLTKEEPER_DRAIN_TIMEOUT` | On SIGTERM, how long running jobs may finish (`30s` default, `2m`, `500ms`) |

### Health, readiness, metrics, shutdown

- `GET /healthz` — 200 while the process answers.
- `GET /readyz` — 200 when the store answers a query (stores migrate before their first answer; Postgres is also asked `ready()`), the artifact store lists, and the process is not draining; 503 with a JSON body per check otherwise.
- `GET /metrics` — Prometheus text format. Neither needs authentication; keep `/metrics` off public ingresses (the chart's Ingress only routes to the web Service, but the path is served there too — block it at the ingress if the host is public).
- SIGTERM: readiness fails at once, the worker stops claiming, running jobs get the drain timeout to finish and are then aborted and requeued to run again at once on another worker (the interrupted attempt counts), the leader lease is released, the store is closed. Give the container a grace period longer than the drain timeout.

| Metric                                                       | Type      | Source                                                 |
| ------------------------------------------------------------ | --------- | ------------------------------------------------------ |
| `holtkeeper_jobs_queued`                                     | gauge     | store: queued jobs due now (the scaling signal)        |
| `holtkeeper_jobs{status="queued"\|"running"}`                | gauge     | store                                                  |
| `holtkeeper_jobs_finished_total{analyzer,status}`            | counter   | this process                                           |
| `holtkeeper_job_duration_seconds{analyzer}`                  | histogram | this process (last attempt of each finished job)       |
| `holtkeeper_webhook_events_total{forge,status}`              | counter   | this process                                           |
| `holtkeeper_ai_runs_total{provider,model}`                   | counter   | store (AI usage records)                               |
| `holtkeeper_ai_tokens_total{provider,model,kind}`            | counter   | store                                                  |
| `holtkeeper_ai_cost_usd_total{provider,model}`               | counter   | store                                                  |
| `holtkeeper_limiter_saturated{key}`, `_in_flight`, `_queued` | gauge     | this process's limiter (shared state when distributed) |
| `holtkeeper_artifact_store_bytes`, `_objects`                | gauge     | artifact store, listed at most every 5 minutes         |
| `holtkeeper_draining`                                        | gauge     | this process                                           |

Store-backed series are reported only by processes with the API (web, all); every such process reports the same value, so aggregate them with `max`, not `sum`.

## Requirements for more than one process

- **Postgres** (`@holtkeeper/store-postgres`). SQLite is a local file; it works for one process (or several in one container sharing the file), not for pods on different nodes.
- **S3-compatible artifacts** (`server.artifacts: { kind: 's3', ... }`: any S3-compatible storage — AWS S3, Cloudflare R2, Garage, Ceph, MinIO, Versity S3 Gateway — including one you already run). Workers write artifacts, web pods serve them.
- **Distributed limits**: `limits: { distributed: true }` keeps credential limiter counters in the store's `kv` (compare-and-set), so several workers share one token's rate and concurrency limits. Slots held by a process that dies are returned after 2 minutes without its heartbeat.
- The same `server.vaultKey` everywhere.

## Docker

Build the sandbox base, then the server image (multi-stage: `bun install --frozen-lockfile`, web UI build, runtime on the base with Bun and the workspace source — packages need no build):

```sh
docker build -t holtkeeper-worker:latest docker/worker
docker build -t holtkeeper:latest .          # --build-arg BASE_IMAGE=... for another base
```

The image runs as uid 10001, works with a read-only root filesystem (writable: `/tmp`, `/data`, `/workspace`, `/mise`), has a `HEALTHCHECK` on `/healthz` and the entrypoint `holtkeeper serve`. The config is mounted at `/app/config/holtkeeper.config.ts` (inside `/app` so its `@holtkeeper/*` imports resolve); [deploy/holtkeeper.config.ts](../deploy/holtkeeper.config.ts) is a starting point that reads every secret from the environment and picks Postgres and S3 when their variables are set. Listen on `0.0.0.0` in containers.

### Single container

```sh
docker run -d --name holtkeeper -p 7420:7420 --env-file .env --read-only --tmpfs /tmp \
  -v "$PWD/holtkeeper.config.ts:/app/config/holtkeeper.config.ts:ro" \
  -v holtkeeper-data:/data -v holtkeeper-workspace:/workspace -v holtkeeper-mise:/mise \
  holtkeeper:latest -c /app/config/holtkeeper.config.ts --role all
```

SQLite and artifacts live in the `/data` volume; back it up (stop the container or use `sqlite3 .backup`).

### Compose

[deploy/docker-compose.yml](../deploy/docker-compose.yml): `web` (`web,scheduler`), `worker` (scale it), Postgres 17, and artifacts in S3: point `S3_ENDPOINT`, `S3_BUCKET` and the keys in `.env` at your existing S3-compatible storage, or start the bundled [Versity S3 Gateway](https://github.com/versity/versitygw) (posix backend in a volume) with `docker compose --profile local-s3 up -d` to try it without one. Secrets come from `deploy/.env` (template: `deploy/.env.example`), the config from `deploy/holtkeeper.config.ts`.

```sh
cd deploy && cp .env.example .env && $EDITOR .env
docker compose up -d --scale worker=3
```

The file has a commented single-container `all` service with SQLite for small installs. Add `--max-jobs 1` to the worker command for a fresh container per job (`restart: unless-stopped` brings it back).

Jobs run inside the worker container in `mise` execution mode: the container is the sandbox, there is no container engine inside. `container` mode (one engine container per job, see [docker/worker](../docker/worker/README.md)) needs the host's Docker socket, which defeats the isolation — use it only for the single-host setup without compose.

## Kubernetes

The chart [deploy/helm/holtkeeper](../deploy/helm/holtkeeper) renders:

- a ConfigMap with `holtkeeper.config.ts` (`config.content`, default the chart's `files/holtkeeper.config.ts`; or `config.existingConfigMap`), mounted read-only; pods restart when it changes;
- `existingSecret` → environment of every container (`HOLTKEEPER_VAULT_KEY`, `HOLTKEEPER_DATABASE_URL`, `HOLTKEEPER_S3_*`, `HOLTKEEPER_ROOT_PASSWORD`, `HOLTKEEPER_SESSION_SECRET`, `HOLTKEEPER_WEBHOOK_SECRET`, `GITLAB_TOKEN`, ...); `env` for plain values (`HOLTKEEPER_AUTH=users` switches the default config from the `root` password to accounts with passkeys: the first start logs the admin's setup link, `HOLTKEEPER_ADMIN_NAME`/`HOLTKEEPER_ADMIN_EMAIL` name that admin, `HOLTKEEPER_PUBLIC_URL` is required);
- `web` Deployment + Service (+ Ingress, + HPA on CPU, + PodDisruptionBudget), roles `web,scheduler`;
- `worker` Deployment (`replicas`, `concurrency`, `maxJobs`, `drainTimeout`, resources) with a headless Service for metrics, PDB; or, with `worker.pools`, one Deployment per pool (`<release>-worker-<name>`, label `holtkeeper.dev/worker-pool`), each `worker` with the pool's own fields on top, e.g. 2 jobs per small node and 4 on a big one; `spread: true` keeps a pool's pods on different nodes;
- optional `scheduler` Deployment (`scheduler.enabled`; the web pods then run `web` only);
- optional ServiceMonitor, KEDA ScaledObject or ScaledJob, NetworkPolicies;
- optional egress proxy (`egressProxy.enabled`, see below);
- a ServiceAccount without any Role: nothing talks to the Kubernetes API and no pod-creation rights are needed. Tokens are not mounted.

Every pod runs non-root (10001) with `readOnlyRootFilesystem`, no capabilities, `RuntimeDefault` seccomp; `/tmp` (also `HOME`, so bun, npm and Go caches of dependency installs; `tmpSizeLimit`, default 8Gi), `/workspace` (checkouts, mirror cache) and `/mise` (tools) are emptyDirs, `/mise` optionally a PVC (`worker.miseCache.type: pvc`, ReadWriteMany to share between workers). Probes: startup and liveness on `/healthz`, readiness on `/readyz`.

```sh
kubectl create secret generic holtkeeper --from-env-file=holtkeeper.env
helm install holtkeeper deploy/helm/holtkeeper --set existingSecret=holtkeeper \
  --set image.repository=registry.example.com/holtkeeper --set image.tag=1.0.0 \
  --set web.ingress.enabled=true --set 'web.ingress.hosts[0].host=holtkeeper.example.com' \
  --set 'web.ingress.hosts[0].paths[0]=/'
```

`values.schema.json` validates the values; `ci/*.yaml` are the files the chart is linted and rendered with.

### Scaling

- **Web**: stateless; scale with `web.replicas` or `web.hpa`. Only one web pod runs the scheduler at a time (lease).
- **Workers**: `worker.replicas` × `concurrency` (summed over `worker.pools`) is the job parallelism. A worker hands a free slot to the job it claimed first among those its credential limits admit, so a long-waiting job is not starved by a stream of short ones. With `keda.enabled` a ScaledObject scales the worker Deployment on `max(holtkeeper_jobs_queued)` from Prometheus (`keda.threshold` queued jobs per replica). The queue also enforces one running job per repository, so more workers than active repositories do not help.
- **Limits**: set `limits.distributed: true` (the default config does when Postgres is used) so forge and AI tokens are rate-limited across all workers, not per pod.

### Isolation: one job per worker pod

Jobs run analyzers (and repository tooling via mise) inside the worker pod. For untrusted repositories give every job a fresh pod:

- `keda.scaledJob.enabled: true` (with `keda.enabled`): a KEDA ScaledJob creates one Kubernetes Job per queued job; its pod runs `--max-jobs 1`, exits 0, and is never reused (`restartPolicy: Never`, `backoffLimit: 0`; a pod that dies mid-job is recovered by the queue's heartbeat timeout and retried on a new pod). `activeDeadlineSeconds` bounds a pod that found no job.
- Without KEDA, `worker.maxJobs: 1` restarts the container after each job. The emptyDirs survive container restarts (the job removes its checkout, the tool cache is kept), and kubelet backs off repeated restarts, so this is weaker and slower than ScaledJob.

Combine with `networkPolicy.enabled`: worker and scheduler pods accept only metrics scrapes (`metricsFrom`) and reach only DNS, `workerEgress` ports (443/80/22 — forge, package registries, LLM APIs) and `extraEgress` (Postgres, object store); web pods accept traffic only from `webIngressFrom` (the ingress controller).

### Egress proxy

`egressProxy.enabled` deploys [docker/egress-proxy](../docker/egress-proxy/README.md): a forward proxy that adds credentials to the requests its `rules` match, so jobs install private packages without ever holding a token. Workers get `HOLTKEEPER_EGRESS_PROXY`, `HOLTKEEPER_EGRESS_CA` (the CA certificate only, never its key) and `HOLTKEEPER_EGRESS_NO_PROXY`; the bundled config turns them into `jobs.execution.egress`. Holtkeeper's own traffic (forge API, database, object store) does not go through it.

```yaml
egressProxy:
  enabled: true
  existingSecret: holtkeeper-egress # GITLAB_PACKAGES_TOKEN=<deploy token with read_package_registry>
  ca:
    certManager: true # or existingSecret: a kubernetes.io/tls Secret with the CA
  rules:
    - host: gitlab.com
      paths: ['^/api/v4/(projects/[^/]+/|groups/[^/]+/-/)?packages/npm/']
      headers:
        Authorization: 'Bearer ${GITLAB_PACKAGES_TOKEN}'
```

`${NAME}` is resolved by the proxy from `existingSecret`, not by Helm. Only `GET`/`HEAD` get credentials unless a rule lists `methods`, and only over TLS unless it sets `insecure`. TLS to hosts without rules is tunneled untouched. The pod restarts when the rules change; restart it after rotating the token or the CA. With `networkPolicy.enabled` the proxy accepts only workers, and workers may reach it.

To use another proxy, leave `egressProxy` disabled and set `HOLTKEEPER_EGRESS_PROXY` (and `HOLTKEEPER_EGRESS_CA`) on the workers yourself.

### Webhooks behind an Ingress

Forges post to `https://<host>/api/webhooks/<forge>`. Set `HOLTKEEPER_PUBLIC_URL` (`server.publicUrl`) so the URLs Holtkeeper registers point at the Ingress host, keep the webhook secret in the Secret, allow request bodies of a few MB (`nginx.ingress.kubernetes.io/proxy-body-size`), and let the forge's egress addresses through `webIngressFrom` when NetworkPolicies are on. Any web pod can take a webhook: it only enqueues jobs in the shared store.

### Backups

- Postgres: regular `pg_dump` (or your operator's backups / PITR) of the `holtkeeper` schema. It holds everything except artifacts; credentials and secret settings in it are sealed with the vault key.
- Artifacts: S3 bucket versioning or replication; artifacts are content-addressed and can be regenerated by rerunning analyses, so this is optional.
- The vault key and the Secret: store them outside the cluster (password manager, KMS). Without the vault key the sealed credentials in a backup cannot be read.
- `/mise` and `/workspace` are caches; never back them up.
