# Egress proxy image

A forward proxy that job commands send their HTTP(S) traffic through. It adds credentials to the requests its rules match, so jobs install private packages (GitLab npm registry, ...) without ever holding a token, and caches downloads of package and tool archives in a directory or an S3 bucket ([Download cache](#download-cache)). It is [mitmproxy](https://mitmproxy.org) `12.3.1` with one addon, [`egress.py`](egress.py) (caching in [`cache.py`](cache.py)).

Holtkeeper does not depend on it: `jobs.execution.egress` (`EgressProxy` of [`@holtkeeper/exec-container`](../../packages/exec-container/docs/README.md#egress-proxy)) accepts any proxy that speaks plain HTTP and `CONNECT`, plus the CA it signs intercepted connections with. Squid with `ssl_bump` and `request_header_add`, or Envoy, can take its place.

## Rules

Rules come from a JSON file (`EGRESS_RULES`, default `/etc/egress/rules.json`, used when it exists), from a URL (`EGRESS_RULES_URL`), or both, file rules first. Holtkeeper serves such a URL at `GET /api/egress/rules` for panel GitLab forges ("Packages for jobs", on by default), carrying each forge credential's current token ([server docs](../../apps/server/docs/README.md#egress-rules)). The document looks the same either way:

```json
{
  "rules": [
    {
      "host": "gitlab.com",
      "paths": ["^/api/v4/(projects/[^/]+/|groups/[^/]+/-/)?packages/npm/"],
      "methods": ["GET", "HEAD"],
      "headers": { "Authorization": "Bearer ${GITLAB_PACKAGES_TOKEN}" }
    },
    {
      "host": "turbo-cache.internal",
      "methods": ["*"],
      "replace": { "6c1d7c9e-3a51-4b8e-9f0a-2d5e8b7c4f10": "${TURBO_TOKEN}" },
      "insecure": true
    }
  ]
}
```

| Field      | Meaning                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `host`     | Destination host, exact or `*.example.com`. Matched against where the request really goes, not its `Host`. |
| `paths`    | Regular expressions searched in the path (with query). Empty or missing: every path.                       |
| `methods`  | Default `GET` and `HEAD`, so a token with write scopes still only reads through the proxy. `*`: any.       |
| `headers`  | Set on matching requests, replacing what the client sent. `${NAME}` reads the proxy's environment.         |
| `replace`  | Placeholder (8 characters or more) to real value, replaced wherever it occurs in the parts `in` names.     |
| `in`       | Where `replace` looks: `headers` (default), `url` (path with query), `body`.                               |
| `insecure` | Also add the headers over plain HTTP. Default `false`: credentials only travel over TLS.                   |

A rule needs `headers`, `replace` or both. The first matching rule sets its headers; every matching rule applies its replacements, so clients holding only a placeholder get the real value on the hosts the rule names and nowhere else. In the file, `${NAME}` reads the proxy's environment, and a variable that is not set stops the proxy at start. Rules from the URL are taken literally. Header values are never logged.

The URL is read with `Authorization: Bearer $EGRESS_RULES_TOKEN` at start, every `EGRESS_RULES_REFRESH` seconds (default 60), and at once (at most every 5 seconds) when an upstream answers a request it added URL credentials to with 401 or 403, which is how a rotated token is picked up. A failed read is logged and keeps the previous rules.

## Download cache

On by default (`EGRESS_CACHE=off` turns it off). Only archives whose content never changes once published are cached, keyed by their URL:

| Kind       | Host                     | Paths                                                |
| ---------- | ------------------------ | ---------------------------------------------------- |
| `packages` | `registry.npmjs.org`     | tarballs `/<name>/-/<file>.tgz`, scoped too          |
| `packages` | `registry.yarnpkg.com`   | the same                                             |
| `packages` | `proxy.golang.org`       | `/@v/<version>.zip`, `.mod`, `.info`                 |
| `packages` | `files.pythonhosted.org` | `/packages/` (the content hash is in the path)       |
| `packages` | `static.crates.io`       | `/crates/`                                           |
| `tools`    | `nodejs.org`             | `/dist/v<version>/<file>`                            |
| `tools`    | `dl.google.com`          | Go releases `/go/go<version>.<os>-<arch>.tar.gz`     |
| `tools`    | `github.com`             | release assets `/<owner>/<repo>/releases/download/…` |

Indexes are never cached — npm packuments, `@v/list` and `@latest`, Node's `index.json`, `api.github.com` — so new versions show up at once. An entry is dropped once unused for its kind's TTL (`EGRESS_CACHE_TTL_PACKAGES`, default 4 weeks; `EGRESS_CACHE_TTL_TOOLS`, default 3 weeks); every hit restarts it. Above `EGRESS_CACHE_MAX_SIZE` the least recently used entries go first. A sweep applies both every `EGRESS_CACHE_SWEEP`. Durations take `s`, `m`, `h`, `d` or `w`; sizes take `Mi`, `Gi`, `M`, `G` and the like.

More URLs go into the rules document as a `cache` list, from the file or the URL:

```json
{
  "rules": [],
  "cache": [{ "kind": "packages", "host": "npm.example.com", "paths": ["/-/[^/]+\\.tgz$"] }]
}
```

`private: true` on such a rule also caches downloads that a rule added credentials to. Without it they always go upstream. Only add patterns for URLs whose content cannot change.

**How it stays out of the way.**

- Only `GET` over TLS without `Range` is cached, and only `200` answers without `Cache-Control: no-store`. A body counts only once it arrived in full and matches `Content-Length`. It is spooled to a file while it streams to the client, then committed, so the proxy holds none of it in memory. Bodies over `EGRESS_CACHE_MAX_ENTRY` (default 4 GiB) pass through.
- A hit rewrites the request to the stored copy: a file server on `127.0.0.1` for a directory, a presigned URL for S3. mitmproxy streams it like any upstream answer, with the original `Content-Type`, `Content-Encoding`, `ETag` and `Last-Modified`, and adds `X-Egress-Cache: hit` (`miss` when a download is being stored).
- Redirects to `release-assets.githubusercontent.com` and `objects.githubusercontent.com` (more with `EGRESS_CACHE_REDIRECT_HOSTS`) are followed: the body is stored under the URL that redirected, so the next request needs neither the redirect nor its expiring signed URL.
- Every store failure (S3 down, disk full, a 2-second lookup timeout) sends the request upstream as if there were no cache, logs a warning and counts an error. The cache never fails an install.
- Cached hosts are intercepted like rule hosts, so their clients need the proxy CA (`egressEnvironment` sets it up for Node, Bun, curl, git, Go, Python and mise).

**Stores.** A directory (`EGRESS_CACHE_DIR`, default `/cache`) or, with `EGRESS_CACHE_S3_BUCKET`, an S3 bucket (path-style URLs, SigV4) that every replica shares. Both use the same layout: `<kind>/<host>/<path>/=body` and `=meta.json` next to it (`url`, `kind`, `size`, `headers`, `storedAt`, `lastUsedAt`, `hits`). The body is written before the meta file, so a meta file always names a complete body. Each replica keeps an index in memory, records uses every minute, and re-reads changed meta files on each sweep. Entries another replica stored are found on the first miss. Hit counts are approximate when replicas share a store. A directory on an `emptyDir` belongs to one replica, so use S3 or a ReadWriteMany volume for several.

**Admin API.** Requests through the proxy to `http://egress-cache.invalid` are answered by the proxy itself and never forwarded. They need `Authorization: Bearer $EGRESS_ADMIN_TOKEN` (default `EGRESS_RULES_TOKEN`) and are refused without a token. `GET /v1/cache?limit=5000` reports the store, TTLs, limits, counters since start, rules, totals and entries, most recently used first. `POST /v1/cache/delete` with `{"paths": [...]}`, `{"kind": "tools"}` or `{}` removes entries. Holtkeeper shows both on its Caches page.

**Security.** A cached copy is served to every client of the proxy for as long as it stays cached, whoever asked first:

- it outlives upstream: an unpublished npm version, a yanked crate or a GitHub release asset replaced under the same tag is still served from the cache. Lockfile checksums keep a replaced file from being installed, and nothing keeps a removed one from being installed;
- with `private` rules it outlives access: a package fetched with a forge token stays available to every job after the token is revoked, the forge's "Packages for jobs" is switched off, or the project is made inaccessible. Every job can also read what any other job's credentials fetched. Without the cache that is already true while the credentials work; the cache extends it until the entry expires;
- whoever can write the store can serve any file under any cached URL. Give only the proxy write access to the directory or bucket.

Remove an entry (or a whole kind) on the Caches page or through the admin API to take it out of use at once.

## How it treats traffic

- TLS to a host no rule names is tunneled untouched: clients see the real certificate and need no extra trust. Only when both the `CONNECT` destination and the SNI name a rule host is the connection intercepted and re-signed with the proxy CA.
- Upstream certificates are verified as usual, so a spoofed DNS answer gets no credentials.
- Plain HTTP passes through; headers are added only for `insecure` rules.

## Environment

| Variable                                                    | Default                                      | Meaning                                                                                                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EGRESS_PORT`                                               | `8080`                                       | Listening port.                                                                                                                                                                    |
| `EGRESS_RULES`                                              | `/etc/egress/rules.json`                     | Rules file; skipped when missing.                                                                                                                                                  |
| `EGRESS_RULES_URL`                                          | —                                            | URL that serves rules.                                                                                                                                                             |
| `EGRESS_RULES_TOKEN`                                        | —                                            | Bearer token for `EGRESS_RULES_URL`.                                                                                                                                               |
| `EGRESS_RULES_REFRESH`                                      | `60`                                         | Seconds between reads of `EGRESS_RULES_URL`.                                                                                                                                       |
| `EGRESS_CA_DIR`                                             | —                                            | Directory with `tls.crt` and `tls.key` of the CA (a `kubernetes.io/tls` Secret). Without it mitmproxy makes a CA of its own at every start, which clients cannot trust in advance. |
| `EGRESS_CONFDIR`                                            | `/tmp/mitmproxy`                             | mitmproxy's working directory.                                                                                                                                                     |
| `EGRESS_CACHE`                                              | `on`                                         | `off` turns the download cache off.                                                                                                                                                |
| `EGRESS_CACHE_DIR`                                          | `/cache`                                     | Directory store; ignored with `EGRESS_CACHE_S3_BUCKET`. When it cannot be created, the proxy runs without a cache and logs why.                                                    |
| `EGRESS_CACHE_TTL_PACKAGES`, `EGRESS_CACHE_TTL_TOOLS`       | `28d`, `21d`                                 | Time since the last use after which an entry is dropped.                                                                                                                           |
| `EGRESS_CACHE_MAX_SIZE`                                     | —                                            | Total size above which least recently used entries go first.                                                                                                                       |
| `EGRESS_CACHE_MAX_ENTRY`                                    | `4Gi`                                        | Larger downloads are not cached.                                                                                                                                                   |
| `EGRESS_CACHE_SWEEP`                                        | `1h`                                         | Interval of expiry, size limit and index refresh.                                                                                                                                  |
| `EGRESS_CACHE_DEFAULTS`                                     | `on`                                         | `off` drops the built-in cached URLs, leaving only `cache` rules.                                                                                                                  |
| `EGRESS_CACHE_REDIRECT_HOSTS`                               | —                                            | More hosts, comma-separated, whose redirected downloads are stored.                                                                                                                |
| `EGRESS_CACHE_S3_BUCKET`, `_ENDPOINT`, `_REGION`, `_PREFIX` | —                                            | S3 store; endpoint default `https://s3.<region>.amazonaws.com`, region default `AWS_REGION` or `us-east-1`.                                                                        |
| `EGRESS_CACHE_S3_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`       | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | S3 keys.                                                                                                                                                                           |
| `EGRESS_CACHE_SPOOL`                                        | `/tmp/egress-spool`                          | Where S3 downloads are spooled until complete (a directory store spools inside itself).                                                                                            |
| `EGRESS_ADMIN_TOKEN`                                        | `EGRESS_RULES_TOKEN`                         | Bearer token of the admin API.                                                                                                                                                     |

Arguments after the image name go to `mitmdump`. Runs as the image's `mitmproxy` user and needs `/tmp` and the cache directory (`/cache`, owned by that user in the image) writable.

## Build and test

```sh
docker build -t holtkeeper-egress-proxy:latest docker/egress-proxy
mise exec -- bun test docker/egress-proxy
```

The release workflow publishes `ghcr.io/holtkeeper/holtkeeper-egress-proxy:<sha>` with the main image. The test starts a real `mitmdump` (from `mise.toml`) and is skipped when it or `openssl` is missing. The cache tests run against a directory and an in-memory S3 that checks SigV4 signatures. In Kubernetes the chart's `egressProxy` values deploy it; see [docs/deployment.md](../../docs/deployment.md#egress-proxy).
