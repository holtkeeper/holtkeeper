# syntax=docker/dockerfile:1
# Egress proxy for Holtkeeper jobs: mitmproxy with the `egress.py` addon, which adds credentials to
# requests that match its rules, and caches package and tool downloads (`cache.py`). See README.md.
FROM mitmproxy/mitmproxy:12.3.1

COPY --chmod=0755 entrypoint.sh /usr/local/bin/egress-proxy
COPY egress.py cache.py /app/
RUN mkdir -p /cache && chown mitmproxy /cache

ENV PYTHONUNBUFFERED=1
USER mitmproxy
EXPOSE 8080
ENTRYPOINT ["egress-proxy"]
