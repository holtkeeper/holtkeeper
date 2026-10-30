# syntax=docker/dockerfile:1
# Egress proxy for Holtkeeper jobs: mitmproxy with the `egress.py` addon, which adds credentials to
# requests that match its rules. See README.md.
FROM mitmproxy/mitmproxy:12.3.1

COPY --chmod=0755 entrypoint.sh /usr/local/bin/egress-proxy
COPY egress.py /app/egress.py

ENV PYTHONUNBUFFERED=1
USER mitmproxy
EXPOSE 8080
ENTRYPOINT ["egress-proxy"]
