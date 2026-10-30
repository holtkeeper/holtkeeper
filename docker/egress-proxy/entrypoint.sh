#!/bin/sh
# mitmproxy reads its CA as key and certificate in one PEM file inside its confdir.
set -eu
confdir="${EGRESS_CONFDIR:-/tmp/mitmproxy}"
mkdir -p "$confdir"
if [ -n "${EGRESS_CA_DIR:-}" ]; then
  umask 077
  cat "$EGRESS_CA_DIR/tls.key" "$EGRESS_CA_DIR/tls.crt" > "$confdir/mitmproxy-ca.pem"
fi
rules="${EGRESS_RULES:-/etc/egress/rules.json}"
if [ -f "$rules" ]; then
  set -- --set egress_rules="$rules" "$@"
fi
if [ -n "${EGRESS_RULES_URL:-}" ]; then
  set -- --set egress_rules_url="$EGRESS_RULES_URL" \
    --set egress_rules_refresh="${EGRESS_RULES_REFRESH:-60}" "$@"
fi
exec mitmdump \
  --set confdir="$confdir" \
  --listen-port "${EGRESS_PORT:-8080}" \
  -s /app/egress.py \
  "$@"
