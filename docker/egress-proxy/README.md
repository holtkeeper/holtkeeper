# Egress proxy image

A forward proxy that job commands send their HTTP(S) traffic through. It adds credentials to the requests its rules match, so jobs install private packages (GitLab npm registry, ...) without ever holding a token. It is [mitmproxy](https://mitmproxy.org) `12.3.1` with one addon, [`egress.py`](egress.py).

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

## How it treats traffic

- TLS to a host no rule names is tunneled untouched: clients see the real certificate and need no extra trust. Only when both the `CONNECT` destination and the SNI name a rule host is the connection intercepted and re-signed with the proxy CA.
- Upstream certificates are verified as usual, so a spoofed DNS answer gets no credentials.
- Plain HTTP passes through; headers are added only for `insecure` rules.

## Environment

| Variable               | Default                  | Meaning                                                                                                                                                                            |
| ---------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EGRESS_PORT`          | `8080`                   | Listening port.                                                                                                                                                                    |
| `EGRESS_RULES`         | `/etc/egress/rules.json` | Rules file; skipped when missing.                                                                                                                                                  |
| `EGRESS_RULES_URL`     | —                        | URL that serves rules.                                                                                                                                                             |
| `EGRESS_RULES_TOKEN`   | —                        | Bearer token for `EGRESS_RULES_URL`.                                                                                                                                               |
| `EGRESS_RULES_REFRESH` | `60`                     | Seconds between reads of `EGRESS_RULES_URL`.                                                                                                                                       |
| `EGRESS_CA_DIR`        | —                        | Directory with `tls.crt` and `tls.key` of the CA (a `kubernetes.io/tls` Secret). Without it mitmproxy makes a CA of its own at every start, which clients cannot trust in advance. |
| `EGRESS_CONFDIR`       | `/tmp/mitmproxy`         | mitmproxy's working directory.                                                                                                                                                     |

Arguments after the image name go to `mitmdump`. Runs as the image's `mitmproxy` user and needs only `/tmp` writable.

## Build and test

```sh
docker build -t holtkeeper-egress-proxy:latest docker/egress-proxy
mise exec -- bun test docker/egress-proxy
```

The release workflow publishes `ghcr.io/holtkeeper/holtkeeper-egress-proxy:<sha>` with the main image. The test starts a real `mitmdump` (from `mise.toml`) and is skipped when it or `openssl` is missing. In Kubernetes the chart's `egressProxy` values deploy it; see [docs/deployment.md](../../docs/deployment.md#egress-proxy).
