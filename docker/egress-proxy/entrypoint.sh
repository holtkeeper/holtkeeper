#!/bin/sh
# mitmproxy reads its CA as key and certificate in one PEM file inside its confdir.
set -eu
confdir="${EGRESS_CONFDIR:-/tmp/mitmproxy}"
mkdir -p "$confdir"
if [ -n "${EGRESS_CA_DIR:-}" ]; then
  umask 077
  cat "$EGRESS_CA_DIR/tls.key" "$EGRESS_CA_DIR/tls.crt" > "$confdir/mitmproxy-ca.pem"
fi
exec mitmdump \
  --set confdir="$confdir" \
  --listen-port "${EGRESS_PORT:-8080}" \
  --set egress_rules="${EGRESS_RULES:-/etc/egress/rules.json}" \
  -s /app/egress.py \
  "$@"
