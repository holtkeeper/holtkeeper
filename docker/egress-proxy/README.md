# Egress proxy image

A forward proxy that job commands send their HTTP(S) traffic through. It adds credentials to the requests its rules match, so jobs install private packages (GitLab npm registry, ...) without ever holding a token. It is [mitmproxy](https://mitmproxy.org) `12.3.1` with one addon, [`egress.py`](egress.py).

Holtkeeper does not depend on it: `jobs.execution.egress` (`EgressProxy` of [`@holtkeeper/exec-container`](../../packages/exec-container/docs/README.md#egress-proxy)) accepts any proxy that speaks plain HTTP and `CONNECT`, plus the CA it signs intercepted connections with. Squid with `ssl_bump` and `request_header_add`, or Envoy, can take its place.

## Rules

A JSON file (`EGRESS_RULES`, default `/etc/egress/rules.json`):

```json
{
  "rules": [
    {
      "host": "gitlab.com",
      "paths": ["^/api/v4/(projects/[^/]+/|groups/[^/]+/-/)?packages/npm/"],
      "methods": ["GET", "HEAD"],
      "headers": { "Authorization": "Bearer ${GITLAB_PACKAGES_TOKEN}" }
    }
  ]
}
```

| Field      | Meaning                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `host`     | Destination host, exact or `*.example.com`. Matched against where the request really goes, not its `Host`. |
| `paths`    | Regular expressions searched in the path (with query). Empty or missing: every path.                       |
| `methods`  | Default `GET` and `HEAD`, so a token with write scopes still only reads through the proxy.                 |
| `headers`  | Set on matching requests, replacing what the client sent. `${NAME}` reads the proxy's environment.         |
| `insecure` | Also add the headers over plain HTTP. Default `false`: credentials only travel over TLS.                   |

The first matching rule wins. A `${NAME}` that is not set stops the proxy at start. Header values are never logged.

## How it treats traffic

- TLS to a host no rule names is tunneled untouched: clients see the real certificate and need no extra trust. Only when both the `CONNECT` destination and the SNI name a rule host is the connection intercepted and re-signed with the proxy CA.
- Upstream certificates are verified as usual, so a spoofed DNS answer gets no credentials.
- Plain HTTP passes through; headers are added only for `insecure` rules.

## Environment

| Variable         | Default                  | Meaning                                                                                                                                                                            |
| ---------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EGRESS_PORT`    | `8080`                   | Listening port.                                                                                                                                                                    |
| `EGRESS_RULES`   | `/etc/egress/rules.json` | Rules file.                                                                                                                                                                        |
| `EGRESS_CA_DIR`  | —                        | Directory with `tls.crt` and `tls.key` of the CA (a `kubernetes.io/tls` Secret). Without it mitmproxy makes a CA of its own at every start, which clients cannot trust in advance. |
| `EGRESS_CONFDIR` | `/tmp/mitmproxy`         | mitmproxy's working directory.                                                                                                                                                     |

Arguments after the image name go to `mitmdump`. Runs as the image's `mitmproxy` user and needs only `/tmp` writable.

## Build and test

```sh
docker build -t holtkeeper-egress-proxy:latest docker/egress-proxy
mise exec -- bun test docker/egress-proxy
```

The release workflow publishes `ghcr.io/holtkeeper/holtkeeper-egress-proxy:<sha>` with the main image. The test starts a real `mitmdump` (from `mise.toml`) and is skipped when it or `openssl` is missing. In Kubernetes the chart's `egressProxy` values deploy it; see [docs/deployment.md](../../docs/deployment.md#egress-proxy).
