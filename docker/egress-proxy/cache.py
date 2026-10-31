"""Download cache of the egress proxy: immutable package and tool archives, kept in a directory or
an S3 bucket until they go unused for their kind's TTL.

Only URLs that cache rules name are cached, only for `GET` over TLS, only `200` answers without
`no-store`, and only once the body arrived in full. A hit rewrites the request to the stored copy
(a local file server for a directory, a presigned URL for S3), so mitmproxy streams it like any
upstream answer. Any failure of the store sends the request upstream as if there were no cache.

Layout, the same in both stores: `<kind>/<host>/<path>/=body` and `<kind>/<host>/<path>/=meta.json`
(`{url, kind, size, headers, storedAt, lastUsedAt, hits}`); a query becomes `~<hash>` on the last
segment. The body is written first, so a meta file always names a complete body.
"""

import asyncio
import datetime as dt
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mitmproxy import http

KINDS = ("packages", "tools")
DEFAULT_TTL = {"packages": 28 * 86400, "tools": 21 * 86400}
STORED_HEADERS = ("content-type", "content-encoding", "etag", "last-modified")
ADMIN_HOST = "egress-cache.invalid"
LOOKUP_TIMEOUT = 2.0
FLUSH_INTERVAL = 60.0
REDIRECT_TTL = 300.0
SPOOL_MAX_AGE = 86400.0

# Archives whose content never changes once published. Indexes (packuments, `@v/list`, version
# lists) are deliberately absent: they change, and a stale one is how caches break installs.
DEFAULT_RULES = [
    {"kind": "packages", "host": "registry.npmjs.org", "paths": [r"^/(@[^/]+/)?[^/]+/-/[^/]+\.tgz$"]},
    {"kind": "packages", "host": "registry.yarnpkg.com", "paths": [r"^/(@[^/]+/)?[^/]+/-/[^/]+\.tgz$"]},
    {"kind": "packages", "host": "proxy.golang.org", "paths": [r"/@v/[^/]+\.(zip|mod|info)$"]},
    {"kind": "packages", "host": "files.pythonhosted.org", "paths": [r"^/packages/"]},
    {"kind": "packages", "host": "static.crates.io", "paths": [r"^/crates/"]},
    {"kind": "tools", "host": "nodejs.org", "paths": [r"^/dist/v[^/]+/[^/]+$"]},
    {"kind": "tools", "host": "dl.google.com", "paths": [r"^/go/go[0-9][^/]*\.(tar\.gz|zip)$"]},
    {"kind": "tools", "host": "github.com", "paths": [r"^/[^/]+/[^/]+/releases/download/[^/]+/[^/]+$"]},
]
# Where the hosts above redirect downloads to, with signed URLs that expire: their bodies are
# stored under the URL that redirected.
DEFAULT_REDIRECT_HOSTS = ("release-assets.githubusercontent.com", "objects.githubusercontent.com")


def parse_duration(text: str) -> int:
    """Seconds of `90`, `90s`, `30m`, `12h`, `28d` or `4w`."""
    match = re.fullmatch(r"\s*(\d+)\s*([smhdw]?)\s*", text or "")
    if not match:
        raise ValueError(f"expected a duration such as 28d, got {text!r}")
    unit = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[match.group(2)]
    return int(match.group(1)) * unit


def parse_size(text: str) -> int:
    """Bytes of `1048576`, `500M`, `500Mi`, `20G`, `20Gi`."""
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([KMGT]?)(i?)B?\s*", text or "", re.IGNORECASE)
    if not match:
        raise ValueError(f"expected a size such as 20Gi, got {text!r}")
    base = 1024 if match.group(3) else 1000
    power = " KMGT".index(match.group(2).upper() or " ")
    return int(float(match.group(1)) * base**power)


def iso(seconds: float) -> str:
    return dt.datetime.fromtimestamp(seconds, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def epoch(text: str) -> float:
    return dt.datetime.fromisoformat(text).timestamp()


@dataclass(frozen=True)
class CacheRule:
    kind: str
    host: str
    paths: tuple[re.Pattern[str], ...]
    private: bool

    def matches_host(self, host: str) -> bool:
        host = host.lower().rstrip(".")
        if self.host.startswith("*."):
            return host.endswith(self.host[1:])
        return host == self.host

    def matches(self, request: http.Request) -> bool:
        return (
            self.matches_host(request.host)
            and request.scheme == "https"
            and request.method == "GET"
            and (not self.paths or any(p.search(request.path) for p in self.paths))
        )


def parse_cache_rules(raw: object, where: str = "cache") -> list[CacheRule]:
    """Cache rules of a `[{kind, host, paths?, private?}]` list."""
    if not isinstance(raw, list):
        raise ValueError(f"{where}: expected a list")
    rules = []
    for index, item in enumerate(raw):
        at = f"{where}[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{at}: expected an object")
        if item.get("kind") not in KINDS:
            raise ValueError(f"{at}.kind: expected one of {', '.join(KINDS)}")
        host = item.get("host")
        if not isinstance(host, str) or not host:
            raise ValueError(f"{at}.host: expected a host name")
        rules.append(
            CacheRule(
                kind=item["kind"],
                host=host.lower().rstrip("."),
                paths=tuple(re.compile(p) for p in item.get("paths") or []),
                private=bool(item.get("private", False)),
            )
        )
    return rules


def entry_path(kind: str, url: str) -> str | None:
    """Where the entry for `url` lives; `None` for URLs that cannot map to a safe path."""
    parts = urllib.parse.urlsplit(url)
    if not parts.hostname:
        return None
    host = parts.hostname.lower() + (f":{parts.port}" if parts.port else "")
    segments = parts.path.split("/")[1:]
    if not segments or any(s in ("", ".", "..") or s.startswith("=") or "\\" in s for s in segments):
        return None
    if parts.query:
        segments[-1] += "~" + hashlib.sha256(parts.query.encode()).hexdigest()[:16]
    return "/".join([kind, host, *segments])


class DirStore:
    """Entries as files below `root`; hits are served by a file server on 127.0.0.1."""

    def __init__(self, root: str) -> None:
        os.makedirs(root, exist_ok=True)
        self.root = os.path.realpath(root)
        self.spool_dir = os.path.join(self.root, ".spool")
        os.makedirs(self.spool_dir, exist_ok=True)
        self.server: ThreadingHTTPServer | None = None

    def describe(self) -> dict:
        return {"kind": "dir", "location": self.root}

    def file(self, path: str, name: str) -> str:
        target = os.path.realpath(os.path.join(self.root, path, name))
        if not target.startswith(self.root + os.sep):
            raise ValueError("path escapes the cache directory")
        return target

    def read_meta(self, path: str) -> dict | None:
        try:
            with open(self.file(path, "=meta.json"), encoding="utf-8") as handle:
                return json.load(handle)
        except FileNotFoundError:
            return None

    def write_meta(self, path: str, meta: dict) -> None:
        target = self.file(path, "=meta.json")
        temp = f"{target}.{uuid.uuid4().hex}.tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(meta, handle)
        os.replace(temp, target)

    def exists(self, path: str) -> bool:
        return os.path.isfile(self.file(path, "=body"))

    def commit(self, path: str, spooled: str, meta: dict) -> None:
        body = self.file(path, "=body")
        os.makedirs(os.path.dirname(body), exist_ok=True)
        os.replace(spooled, body)
        self.write_meta(path, meta)

    def delete(self, path: str) -> None:
        for name in ("=meta.json", "=body"):
            try:
                os.remove(self.file(path, name))
            except FileNotFoundError:
                pass
        directory = os.path.dirname(self.file(path, "=body"))
        while directory != self.root:
            try:
                os.rmdir(directory)
            except OSError:
                break
            directory = os.path.dirname(directory)

    def list_meta(self) -> dict[str, str]:
        found = {}
        for kind in KINDS:
            for current, _, files in os.walk(os.path.join(self.root, kind)):
                if "=meta.json" in files:
                    stat = os.stat(os.path.join(current, "=meta.json"))
                    found[os.path.relpath(current, self.root)] = f"{stat.st_mtime_ns}:{stat.st_size}"
        return found

    def hit_url(self, path: str) -> str:
        if self.server is None:
            self.server = serve_files(self.root)
        port = self.server.server_address[1]
        return f"http://127.0.0.1:{port}/{urllib.parse.quote(path)}/%3Dbody"

    def close(self) -> None:
        if self.server:
            self.server.shutdown()


def serve_files(root: str) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip("/")
            target = os.path.realpath(os.path.join(root, path))
            if not target.startswith(root + os.sep) or not target.endswith("/=body"):
                self.send_error(404)
                return
            try:
                handle = open(target, "rb")
            except OSError:
                self.send_error(404)
                return
            with handle:
                self.send_response(200)
                self.send_header("Content-Length", str(os.fstat(handle.fileno()).st_size))
                self.end_headers()
                shutil.copyfileobj(handle, self.wfile, 1 << 20)

        def log_message(self, *_: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class S3Store:
    """Entries as objects of a bucket (path-style URLs, SigV4 presigned); hits fetch presigned URLs."""

    def __init__(
        self,
        bucket: str,
        endpoint: str,
        region: str,
        access_key: str,
        secret_key: str,
        prefix: str,
        spool_dir: str,
    ) -> None:
        parts = urllib.parse.urlsplit(endpoint)
        default = {"https": 443, "http": 80}.get(parts.scheme)
        port = f":{parts.port}" if parts.port and parts.port != default else ""
        self.base = f"{parts.scheme}://{parts.hostname}{port}"
        self.host = f"{parts.hostname}{port}"
        self.bucket = bucket
        self.region = region
        self.access_key = access_key
        self.secret_key = secret_key
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        self.spool_dir = spool_dir
        os.makedirs(self.spool_dir, exist_ok=True)

    def describe(self) -> dict:
        return {"kind": "s3", "location": f"{self.base}/{self.bucket}/{self.prefix}"}

    def presign(self, method: str, key: str | None, query: dict[str, str] | None = None, expires: int = 600) -> str:
        path = f"/{self.bucket}" + (f"/{urllib.parse.quote(key, safe='/')}" if key is not None else "")
        return presign(
            method,
            self.base,
            self.host,
            path,
            query or {},
            self.region,
            self.access_key,
            self.secret_key,
            expires,
            time.time(),
        )

    def call(self, method: str, key: str | None, query=None, data=None, headers=None) -> bytes | None:
        """The body of the answer; `None` for 404."""
        request = urllib.request.Request(self.presign(method, key, query), data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise

    def read_meta(self, path: str) -> dict | None:
        body = self.call("GET", f"{self.prefix}{path}/=meta.json")
        return None if body is None else json.loads(body)

    def write_meta(self, path: str, meta: dict) -> None:
        data = json.dumps(meta).encode()
        self.call("PUT", f"{self.prefix}{path}/=meta.json", data=data, headers={"Content-Type": "application/json"})

    def exists(self, path: str) -> bool:
        return self.call("HEAD", f"{self.prefix}{path}/=body") is not None

    def commit(self, path: str, spooled: str, meta: dict) -> None:
        try:
            with open(spooled, "rb") as handle:
                size = os.fstat(handle.fileno()).st_size
                self.call(
                    "PUT",
                    f"{self.prefix}{path}/=body",
                    data=handle,
                    headers={"Content-Length": str(size), "Content-Type": "application/octet-stream"},
                )
            self.write_meta(path, meta)
        finally:
            os.remove(spooled)

    def delete(self, path: str) -> None:
        for name in ("=meta.json", "=body"):
            self.call("DELETE", f"{self.prefix}{path}/{name}")

    def list_meta(self) -> dict[str, str]:
        found = {}
        token = None
        while True:
            query = {"list-type": "2", "prefix": self.prefix}
            if token:
                query["continuation-token"] = token
            root = ET.fromstring(self.call("GET", None, query) or b"<r/>")
            ns = {"s3": root.tag[1 : root.tag.index("}")]} if root.tag.startswith("{") else {}
            find = (lambda e, n: e.find(f"s3:{n}", ns)) if ns else (lambda e, n: e.find(n))
            for item in root.findall("s3:Contents", ns) if ns else root.findall("Contents"):
                key = find(item, "Key").text or ""
                if key.endswith("/=meta.json"):
                    stamp = find(item, "LastModified").text or ""
                    found[key[len(self.prefix) : -len("/=meta.json")]] = f"{stamp}:{find(item, 'Size').text}"
            truncated = find(root, "IsTruncated")
            next_token = find(root, "NextContinuationToken")
            if truncated is None or truncated.text != "true" or next_token is None:
                return found
            token = next_token.text

    def hit_url(self, path: str) -> str:
        return self.presign("GET", f"{self.prefix}{path}/=body")

    def close(self) -> None:
        pass


def presign(method, base, host, path, query, region, access_key, secret_key, expires, now) -> str:
    """A SigV4 query-string signed URL (`UNSIGNED-PAYLOAD`, only `host` signed)."""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now))
    scope = f"{stamp[:8]}/{region}/s3/aws4_request"
    params = {
        **query,
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key}/{scope}",
        "X-Amz-Date": stamp,
        "X-Amz-Expires": str(expires),
        "X-Amz-SignedHeaders": "host",
    }
    encode = lambda value: urllib.parse.quote(value, safe="-_.~")
    canonical_query = "&".join(f"{encode(k)}={encode(v)}" for k, v in sorted(params.items()))
    canonical = "\n".join([method, path, canonical_query, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"])
    to_sign = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = f"AWS4{secret_key}".encode()
    for part in (stamp[:8], region, "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return f"{base}{path}?{canonical_query}&X-Amz-Signature={signature}"


@dataclass
class Spool:
    path: str
    entry: str
    kind: str
    url: str
    headers: dict[str, str]
    expected: int | None
    handle: object = None
    size: int = 0
    failed: bool = False


@dataclass
class Stats:
    since: float = field(default_factory=time.time)
    hits: int = 0
    misses: int = 0
    stored: int = 0
    served_bytes: int = 0
    errors: int = 0


class Cache:
    def __init__(
        self,
        store,
        ttl: dict[str, int],
        max_bytes: int | None,
        max_entry: int,
        sweep_interval: int,
        rules: list[CacheRule],
        redirect_hosts: tuple[str, ...],
        admin_token: str,
    ) -> None:
        self.store = store
        self.ttl = ttl
        self.max_bytes = max_bytes
        self.max_entry = max_entry
        self.sweep_interval = sweep_interval
        self.base_rules = rules
        self.extra_rules: list[CacheRule] = []
        self.redirect_hosts = redirect_hosts
        self.admin_token = admin_token
        self.index: dict[str, dict] = {}
        self.tokens: dict[str, str] = {}
        self.dirty: set[str] = set()
        self.redirects: dict[str, tuple[str, str, str, float]] = {}
        self.lock = threading.Lock()
        self.stats = Stats()
        self.synced_at = 0.0
        self.tasks: set[asyncio.Task] = set()

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "Cache | None":
        if env.get("EGRESS_CACHE", "on").lower() in ("off", "false", "0", "no"):
            return None
        ttl = {
            "packages": parse_duration(env.get("EGRESS_CACHE_TTL_PACKAGES", "28d")),
            "tools": parse_duration(env.get("EGRESS_CACHE_TTL_TOOLS", "21d")),
        }
        max_bytes = parse_size(env["EGRESS_CACHE_MAX_SIZE"]) if env.get("EGRESS_CACHE_MAX_SIZE") else None
        max_entry = parse_size(env.get("EGRESS_CACHE_MAX_ENTRY", "4Gi"))
        sweep = parse_duration(env.get("EGRESS_CACHE_SWEEP", "1h"))
        rules = [] if env.get("EGRESS_CACHE_DEFAULTS", "on").lower() in ("off", "false", "0") else parse_cache_rules(DEFAULT_RULES)
        redirect_hosts = DEFAULT_REDIRECT_HOSTS + tuple(
            h.strip().lower() for h in env.get("EGRESS_CACHE_REDIRECT_HOSTS", "").split(",") if h.strip()
        )
        admin_token = env.get("EGRESS_ADMIN_TOKEN") or env.get("EGRESS_RULES_TOKEN", "")
        if env.get("EGRESS_CACHE_S3_BUCKET"):
            region = env.get("EGRESS_CACHE_S3_REGION") or env.get("AWS_REGION") or "us-east-1"
            store = S3Store(
                bucket=env["EGRESS_CACHE_S3_BUCKET"],
                endpoint=env.get("EGRESS_CACHE_S3_ENDPOINT") or f"https://s3.{region}.amazonaws.com",
                region=region,
                access_key=env.get("EGRESS_CACHE_S3_ACCESS_KEY_ID") or env.get("AWS_ACCESS_KEY_ID", ""),
                secret_key=env.get("EGRESS_CACHE_S3_SECRET_ACCESS_KEY") or env.get("AWS_SECRET_ACCESS_KEY", ""),
                prefix=env.get("EGRESS_CACHE_S3_PREFIX", ""),
                spool_dir=env.get("EGRESS_CACHE_SPOOL", "/tmp/egress-spool"),
            )
        else:
            store = DirStore(env.get("EGRESS_CACHE_DIR", "/cache"))
        return cls(store, ttl, max_bytes, max_entry, sweep, rules, redirect_hosts, admin_token)

    @property
    def rules(self) -> list[CacheRule]:
        return self.base_rules + self.extra_rules

    def names(self, host: str) -> bool:
        host = host.lower().rstrip(".")
        return host == ADMIN_HOST or host in self.redirect_hosts or any(r.matches_host(host) for r in self.rules)

    def expired(self, meta: dict, now: float) -> bool:
        return epoch(meta["lastUsedAt"]) + self.ttl.get(meta["kind"], 0) < now

    def spawn(self, work) -> None:
        task = asyncio.ensure_future(work)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def running(self) -> None:
        self.spawn(self.loop_flush())
        self.spawn(self.loop_sweep())
        backend = self.store.describe()
        days = {kind: round(seconds / 86400, 1) for kind, seconds in self.ttl.items()}
        logging.info(f"egress: caching downloads in {backend['kind']} {backend['location']}, TTL days {days}")

    def done(self) -> None:
        for task in list(self.tasks):
            task.cancel()
        self.flush()
        self.store.close()

    async def loop_flush(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_INTERVAL)
            await asyncio.to_thread(self.flush)

    async def loop_sweep(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.sweep)
            except Exception as error:
                logging.warning(f"egress: cache sweep failed: {error}")
            await asyncio.sleep(self.sweep_interval)

    def flush(self) -> None:
        with self.lock:
            pending = [(path, dict(self.index[path])) for path in self.dirty if path in self.index]
            self.dirty.clear()
        for path, meta in pending:
            try:
                self.store.write_meta(path, meta)
            except Exception as error:
                self.stats.errors += 1
                logging.warning(f"egress: recording use of {path} failed: {error}")

    def sync(self) -> None:
        """Brings the index up to the store, which other replicas may write too."""
        tokens = self.store.list_meta()
        fresh = {}
        for path, token in tokens.items():
            if self.tokens.get(path) == token and path in self.index:
                continue
            meta = self.store.read_meta(path)
            if meta:
                fresh[path] = meta
        with self.lock:
            for path in list(self.index):
                if path not in tokens and path not in self.dirty:
                    del self.index[path]
            for path, meta in fresh.items():
                if path not in self.dirty:
                    self.index[path] = meta
            self.tokens = tokens
            self.synced_at = time.time()

    def sweep(self) -> None:
        self.flush()
        self.sync()
        now = time.time()
        with self.lock:
            entries = sorted(self.index.items(), key=lambda item: item[1]["lastUsedAt"])
        doomed = [path for path, meta in entries if self.expired(meta, now)]
        if self.max_bytes is not None:
            total = sum(meta["size"] for path, meta in entries if path not in doomed)
            for path, meta in entries:
                if total <= self.max_bytes:
                    break
                if path not in doomed:
                    doomed.append(path)
                    total -= meta["size"]
        if doomed:
            self.remove(doomed)
            logging.info(f"egress: cache dropped {len(doomed)} entries unused past their TTL or over the size limit")
        for name in os.listdir(self.store.spool_dir):
            spooled = os.path.join(self.store.spool_dir, name)
            try:
                if now - os.stat(spooled).st_mtime > SPOOL_MAX_AGE:
                    os.remove(spooled)
            except OSError:
                pass

    def remove(self, paths: list[str]) -> dict:
        removed = 0
        size = 0
        for path in paths:
            try:
                self.store.delete(path)
            except Exception as error:
                self.stats.errors += 1
                logging.warning(f"egress: removing {path} from the cache failed: {error}")
                continue
            with self.lock:
                meta = self.index.pop(path, None)
                self.tokens.pop(path, None)
                self.dirty.discard(path)
            removed += 1
            size += meta["size"] if meta else 0
        return {"removed": removed, "bytes": size}

    def rule_for(self, flow: http.HTTPFlow, credentialed: bool) -> CacheRule | None:
        if "range" in flow.request.headers:
            return None
        for rule in self.rules:
            if rule.matches(flow.request):
                return rule if rule.private or not credentialed else None
        return None

    async def lookup(self, path: str) -> dict | None:
        with self.lock:
            meta = self.index.get(path)
        try:
            if meta is None:
                meta = await asyncio.wait_for(asyncio.to_thread(self.store.read_meta, path), LOOKUP_TIMEOUT)
            if meta is None or self.expired(meta, time.time()):
                return None
            if not await asyncio.wait_for(asyncio.to_thread(self.store.exists, path), LOOKUP_TIMEOUT):
                return None
        except Exception as error:
            self.stats.errors += 1
            logging.warning(f"egress: cache lookup of {path} failed, going upstream: {error}")
            return None
        with self.lock:
            self.index.setdefault(path, meta)
            return self.index[path]

    async def request(self, flow: http.HTTPFlow, credentialed: bool) -> None:
        if flow.request.host == ADMIN_HOST:
            await self.admin(flow)
            return
        url = flow.request.url
        alias = self.redirects.pop(url, None)
        if alias and alias[3] > time.time():
            self.prepare_store(flow, alias[0], alias[1], alias[2])
            return
        rule = self.rule_for(flow, credentialed)
        if rule is None:
            return
        path = entry_path(rule.kind, url)
        if path is None:
            return
        meta = await self.lookup(path)
        if meta is None:
            self.stats.misses += 1
            self.prepare_store(flow, path, rule.kind, url)
            return
        self.stats.hits += 1
        self.stats.served_bytes += meta["size"]
        with self.lock:
            meta["hits"] = meta.get("hits", 0) + 1
            meta["lastUsedAt"] = iso(time.time())
            self.dirty.add(path)
        for name in ("authorization", "cookie", "accept-encoding", "if-none-match", "if-modified-since"):
            flow.request.headers.pop(name, None)
        flow.request.url = self.store.hit_url(path)
        flow.metadata["cache_hit"] = meta

    def prepare_store(self, flow: http.HTTPFlow, path: str, kind: str, url: str) -> None:
        flow.request.headers["accept-encoding"] = "identity"
        for name in ("if-none-match", "if-modified-since"):
            flow.request.headers.pop(name, None)
        flow.metadata["cache_store"] = (path, kind, url)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        response = flow.response
        if response is None:
            return
        hit = flow.metadata.get("cache_hit")
        if hit is not None:
            if response.status_code == 200:
                for name in list(response.headers.keys()):
                    if name.lower().startswith("x-amz-") or name.lower() in STORED_HEADERS:
                        del response.headers[name]
                for name, value in hit.get("headers", {}).items():
                    response.headers[name] = value
                response.headers["x-egress-cache"] = "hit"
            response.stream = True
            return
        target = flow.metadata.get("cache_store")
        if target is None:
            return
        path, kind, url = target
        if response.status_code in (301, 302, 303, 307, 308):
            location = response.headers.get("location", "")
            resolved = urllib.parse.urljoin(url, location)
            host = urllib.parse.urlsplit(resolved).hostname or ""
            if resolved.startswith("https://") and self.names(host):
                self.redirects[resolved] = (path, kind, url, time.time() + REDIRECT_TTL)
            return
        cacheable = (
            response.status_code == 200
            and "content-range" not in response.headers
            and "no-store" not in response.headers.get("cache-control", "").lower()
        )
        length = response.headers.get("content-length")
        expected = int(length) if length and length.isdigit() else None
        if not cacheable or (expected is not None and expected > self.max_entry):
            return
        spool = Spool(
            path=os.path.join(self.store.spool_dir, uuid.uuid4().hex),
            entry=path,
            kind=kind,
            url=url,
            headers={k: v for k in STORED_HEADERS if (v := response.headers.get(k))},
            expected=expected,
        )
        try:
            spool.handle = open(spool.path, "wb")
        except OSError as error:
            self.stats.errors += 1
            logging.warning(f"egress: cannot spool {url}: {error}")
            return
        flow.metadata["cache_spool"] = spool
        response.headers["x-egress-cache"] = "miss"
        response.stream = lambda chunk: self.tee(spool, chunk)

    def tee(self, spool: Spool, chunk: bytes) -> bytes:
        if spool.failed:
            return chunk
        try:
            if chunk:
                spool.size += len(chunk)
                if spool.size > self.max_entry:
                    raise ValueError("larger than EGRESS_CACHE_MAX_ENTRY")
                spool.handle.write(chunk)
                return chunk
            spool.handle.close()
            if spool.expected is not None and spool.size != spool.expected:
                raise ValueError(f"got {spool.size} of {spool.expected} bytes")
            self.spawn(asyncio.to_thread(self.commit, spool))
        except Exception as error:
            self.discard(spool)
            logging.info(f"egress: not caching {spool.url}: {error}")
        return chunk

    def discard(self, spool: Spool) -> None:
        spool.failed = True
        try:
            spool.handle.close()
            os.remove(spool.path)
        except OSError:
            pass

    def commit(self, spool: Spool) -> None:
        now = iso(time.time())
        meta = {
            "url": spool.url,
            "kind": spool.kind,
            "size": spool.size,
            "headers": spool.headers,
            "storedAt": now,
            "lastUsedAt": now,
            "hits": 0,
        }
        try:
            self.store.commit(spool.entry, spool.path, meta)
        except Exception as error:
            self.stats.errors += 1
            logging.warning(f"egress: storing {spool.url} in the cache failed: {error}")
            try:
                os.remove(spool.path)
            except OSError:
                pass
            return
        with self.lock:
            self.index[spool.entry] = meta
        self.stats.stored += 1

    def error(self, flow: http.HTTPFlow) -> None:
        spool = flow.metadata.get("cache_spool")
        if spool and not spool.failed:
            self.discard(spool)

    def snapshot(self, limit: int) -> dict:
        now = time.time()
        with self.lock:
            entries = [dict(meta, path=path) for path, meta in self.index.items()]
        entries.sort(key=lambda meta: meta["lastUsedAt"], reverse=True)
        return {
            "backend": self.store.describe(),
            "ttlSeconds": self.ttl,
            "maxBytes": self.max_bytes,
            "maxEntryBytes": self.max_entry,
            "since": iso(self.stats.since),
            "syncedAt": iso(self.synced_at) if self.synced_at else None,
            "stats": {
                "hits": self.stats.hits,
                "misses": self.stats.misses,
                "stored": self.stats.stored,
                "servedBytes": self.stats.served_bytes,
                "errors": self.stats.errors,
            },
            "rules": [
                {"kind": r.kind, "host": r.host, "paths": [p.pattern for p in r.paths], "private": r.private}
                for r in self.rules
            ],
            "total": {"count": len(entries), "bytes": sum(meta["size"] for meta in entries)},
            "entries": [
                {
                    "path": meta["path"],
                    "url": meta["url"],
                    "kind": meta["kind"],
                    "size": meta["size"],
                    "hits": meta.get("hits", 0),
                    "storedAt": meta["storedAt"],
                    "lastUsedAt": meta["lastUsedAt"],
                    "expiresAt": iso(epoch(meta["lastUsedAt"]) + self.ttl.get(meta["kind"], 0)),
                    "expired": self.expired(meta, now),
                }
                for meta in entries[:limit]
            ],
        }

    async def admin(self, flow: http.HTTPFlow) -> None:
        """`GET /v1/cache` and `POST /v1/cache/delete` on the reserved host, behind the admin token."""
        given = flow.request.headers.get("authorization", "")
        expected = f"Bearer {self.admin_token}"
        if not self.admin_token or not hmac.compare_digest(given.encode(), expected.encode()):
            flow.response = http.Response.make(401, b'{"error":"unauthorized"}', {"Content-Type": "application/json"})
            return
        route = (flow.request.method, flow.request.path.split("?")[0])
        try:
            if route == ("GET", "/v1/cache"):
                if time.time() - self.synced_at > 30:
                    await asyncio.to_thread(self.flush)
                    await asyncio.to_thread(self.sync)
                limit = int(flow.request.query.get("limit", "5000"))
                body = self.snapshot(limit)
            elif route == ("POST", "/v1/cache/delete"):
                body = await asyncio.to_thread(self.delete_request, json.loads(flow.request.content or b"{}"))
            else:
                flow.response = http.Response.make(404, b'{"error":"not found"}', {"Content-Type": "application/json"})
                return
        except Exception as error:
            flow.response = http.Response.make(
                500, json.dumps({"error": str(error)}).encode(), {"Content-Type": "application/json"}
            )
            return
        flow.response = http.Response.make(200, json.dumps(body).encode(), {"Content-Type": "application/json"})

    def delete_request(self, body: dict) -> dict:
        """`{paths: [...]}`, `{kind}` or `{}` for everything."""
        self.flush()
        self.sync()
        with self.lock:
            known = dict(self.index)
        if isinstance(body.get("paths"), list):
            paths = [p for p in body["paths"] if isinstance(p, str) and p in known]
        elif body.get("kind") in KINDS:
            paths = [p for p, meta in known.items() if meta["kind"] == body["kind"]]
        else:
            paths = list(known)
        return self.remove(paths)
