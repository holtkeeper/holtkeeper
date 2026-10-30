# syntax=docker/dockerfile:1
# Sandbox image for Holtkeeper jobs: git, mise and the scanners; language runtimes are installed by
# mise into the cache volume mounted at /mise. Versions match the repository's mise.toml.
FROM debian:stable-slim

ARG MISE_VERSION=2026.10.13
ARG OSV_SCANNER_VERSION=2.7.0
ARG GITLEAKS_VERSION=8.30.1
ARG TARGETARCH

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git openssh-client; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) mise_arch=x64; osv_arch=amd64; gitleaks_arch=x64 ;; \
      arm64) mise_arch=arm64; osv_arch=arm64; gitleaks_arch=arm64 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    work="$(mktemp -d)"; cd "$work"; \
    verify() { grep -E "[[:space:]](\./)?$1\$" "$2" | sed 's# \./# #' | sha256sum -c -; }; \
    mise="mise-v${MISE_VERSION}-linux-${mise_arch}"; \
    curl -fsSLO "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${mise}"; \
    curl -fsSLO "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/SHASUMS256.txt"; \
    verify "$mise" SHASUMS256.txt; \
    install -m 0755 "$mise" /usr/local/bin/mise; \
    osv="osv-scanner_linux_${osv_arch}"; \
    curl -fsSLO "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/${osv}"; \
    curl -fsSLO "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_SHA256SUMS"; \
    verify "$osv" osv-scanner_SHA256SUMS; \
    install -m 0755 "$osv" /usr/local/bin/osv-scanner; \
    gitleaks="gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz"; \
    curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${gitleaks}"; \
    curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
    verify "$gitleaks" "gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
    tar -xzf "$gitleaks" gitleaks; \
    install -m 0755 gitleaks /usr/local/bin/gitleaks; \
    cd /; rm -rf "$work"; \
    mise --version; osv-scanner --version; gitleaks version

# Checkouts are bind mounts owned by the host user; the root filesystem is read-only at run time,
# so git's ownership check is relaxed here once.
RUN set -eux; \
    groupadd --gid 10001 holtkeeper; \
    useradd --uid 10001 --gid 10001 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin holtkeeper; \
    mkdir -p /mise /workspace; \
    chown 10001:10001 /mise /workspace; \
    git config --system --add safe.directory '*'

ENV HOME=/tmp \
    MISE_DATA_DIR=/mise \
    MISE_CACHE_DIR=/mise/cache \
    MISE_STATE_DIR=/mise/state \
    MISE_YES=1 \
    MISE_DISABLE_UPDATE_WARNING=1

USER 10001:10001
WORKDIR /workspace
CMD ["sleep", "infinity"]
