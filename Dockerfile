# syntax=docker/dockerfile:1
# Holtkeeper server image: one image for every role (`holtkeeper serve --role web|worker|scheduler|all`).
# The runtime stage builds on the job sandbox image from docker/worker (git, mise, osv-scanner,
# gitleaks), so a worker pod can run jobs in `host` or `mise` execution mode without a container
# engine. Build that image first:
#   docker build -t holtkeeper-worker:latest docker/worker
#   docker build -t holtkeeper:latest .
ARG BUN_VERSION=1.4.4
ARG BASE_IMAGE=holtkeeper-worker:latest

FROM oven/bun:${BUN_VERSION} AS bun

# Full install (dev dependencies included) to build the web UI.
FROM bun AS web
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run --filter @holtkeeper/web build

# Runtime dependencies only. Packages ship TypeScript source; there is no build step for them.
FROM bun AS deps
WORKDIR /app
COPY . .
# The isolated linker links workspace packages only into their dependents; link all of them at the
# root too, so the mounted config can import any `@holtkeeper/*` package.
RUN bun install --frozen-lockfile --ignore-scripts --production --filter '!@holtkeeper/web' \
 && rm -rf apps/web/src apps/web/node_modules fixtures \
 && mkdir -p node_modules/@holtkeeper \
 && for dir in apps/* packages/* plugins/*; do \
      [ -f "$dir/package.json" ] || continue; \
      name="$(bun -e "console.log(require('./$dir/package.json').name)")"; \
      case "$name" in @holtkeeper/*) ln -sfn "../../$dir" "node_modules/$name" ;; esac; \
    done

FROM ${BASE_IMAGE}
USER root
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=deps --chown=10001:10001 /app /app
COPY --from=web --chown=10001:10001 /app/apps/web/dist /app/apps/web/dist
RUN set -eux; \
    printf '#!/bin/sh\nexec bun /app/apps/cli/src/bin.ts "$@"\n' > /usr/local/bin/holtkeeper; \
    chmod 0755 /usr/local/bin/holtkeeper; \
    mkdir -p /app/config /data /workspace; \
    chown 10001:10001 /app/config /data /workspace; \
    bun --version

# The config lives inside /app so its `@holtkeeper/*` imports resolve from /app/node_modules.
# Mount it read-only at /app/config/holtkeeper.config.ts; keep SQLite files and artifacts in /data.
ENV NODE_ENV=production \
    HOLTKEEPER_PORT=7420 \
    HOME=/tmp
USER 10001:10001
WORKDIR /app
VOLUME ["/data"]
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${HOLTKEEPER_PORT}/healthz" >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["holtkeeper", "serve"]
CMD ["-c", "/app/config/holtkeeper.config.ts"]
