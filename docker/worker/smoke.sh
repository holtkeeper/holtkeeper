#!/bin/sh
# Installs and starts every runtime @holtkeeper/toolchain can detect, at its newest version, inside
# the worker image. Catches shared libraries a new upstream build starts to need.
#   docker run --rm -v "$PWD/docker/worker/smoke.sh:/smoke.sh:ro" holtkeeper-worker:latest sh /smoke.sh
set -u
cd /tmp
failed=0
check() {
  tools=$1
  shift
  if out=$(mise install $tools 2>&1 && mise exec $tools -- "$@" 2>&1); then
    echo "ok   $tools"
  else
    echo "FAIL $tools"
    echo "$out" | tail -5
    failed=1
  fi
}
check node@latest node --version
check node@lts node --version
check bun@latest bun --version
check pnpm@latest pnpm --version
check "node@lts yarn@latest" yarn --version
check go@latest go version
check python@latest python --version
check java@latest java -version
check ruby@latest ruby --version
check rust@stable cargo --version
exit "$failed"
