"""mitmproxy addon that adds credentials to matching requests, so clients never hold them.

A rule either sets headers or replaces placeholders with real values (in headers, the URL or the
body), or both; clients then hold only the placeholder. Rules come from a JSON file (option `egress_rules`), from a URL (option `egress_rules_url`, read
with `EGRESS_RULES_TOKEN` as a bearer token), or both. Header values in the file may reference the
proxy's own environment as `${NAME}`; a missing variable fails the start. URL rules are taken
literally and re-read every `egress_rules_refresh` seconds, and at once when an upstream answers a
request with added credentials with 401 or 403; a failed read keeps the previous rules. TLS to hosts
no rule names is tunneled untouched, so clients only need to trust the proxy CA for those hosts.
Downloads of immutable package and tool archives are cached (`cache.py`) unless `EGRESS_CACHE=off`.
"""

import asyncio
import json
import logging
import os
import re
import sys
import time
import urllib.request
from dataclasses import dataclass
from string import Template

from mitmproxy import ctx, http, tls

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cache import Cache, CacheRule, parse_cache_rules  # noqa: E402

DEFAULT_METHODS = ("GET", "HEAD")
TARGETS = ("headers", "url", "body")
MIN_PLACEHOLDER = 8
MIN_REFRESH_GAP = 5.0


@dataclass(frozen=True)
class Rule:
    host: str
    paths: tuple[re.Pattern[str], ...]
    methods: tuple[str, ...]
    headers: dict[str, str]
    replace: dict[str, str]
    targets: tuple[str, ...]
    insecure: bool

    def matches_host(self, host: str) -> bool:
        host = host.lower().rstrip(".")
        if self.host.startswith("*."):
            return host.endswith(self.host[1:])
        return host == self.host

    def matches(self, request: http.Request) -> bool:
        if request.scheme != "https" and not self.insecure:
            return False
        if "*" not in self.methods and request.method.upper() not in self.methods:
            return False
        if not self.matches_host(request.host):
            return False
        return not self.paths or any(p.search(request.path) for p in self.paths)

    def substitute(self, request: http.Request) -> bool:
        """Replaces every placeholder in the rule's targets; whether anything changed."""

        def swap(text: str) -> str:
            for placeholder, value in self.replace.items():
                text = text.replace(placeholder, value)
            return text

        changed = False
        if "headers" in self.targets:
            for name in list(request.headers.keys()):
                values = request.headers.get_all(name)
                swapped = [swap(value) for value in values]
                if swapped != values:
                    request.headers.set_all(name, swapped)
                    changed = True
        if "url" in self.targets:
            path = swap(request.path)
            if path != request.path:
                request.path = path
                changed = True
        if "body" in self.targets and request.raw_content:
            body = request.raw_content
            for placeholder, value in self.replace.items():
                body = body.replace(placeholder.encode(), value.encode())
            if body != request.raw_content:
                request.raw_content = body
                changed = True
        return changed


def resolve(values: dict, env: dict[str, str] | None, where: str) -> dict[str, str]:
    """String values with `${NAME}` read from `env`; `None` keeps them as they are."""
    try:
        return {
            str(k): str(v) if env is None else Template(str(v)).substitute(env)
            for k, v in values.items()
        }
    except KeyError as missing:
        raise ValueError(f"{where}: environment variable {missing} is not set") from None
    except ValueError as error:
        raise ValueError(f"{where}: {error}") from None


def parse_rules(document: object, env: dict[str, str] | None) -> list[Rule]:
    """Rules of a `{"rules": [...]}` document; `env` resolves `${NAME}`, `None` keeps values as is."""
    if not isinstance(document, dict) or not isinstance(document.get("rules"), list):
        raise ValueError('expected {"rules": [...]}')
    rules = []
    for index, raw in enumerate(document["rules"]):
        where = f"rules[{index}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{where}: expected an object")
        host = raw.get("host")
        if not isinstance(host, str) or not host:
            raise ValueError(f"{where}.host: expected a host name")
        headers = raw.get("headers") or {}
        replace = raw.get("replace") or {}
        if not isinstance(headers, dict) or not isinstance(replace, dict):
            raise ValueError(f"{where}: headers and replace must be objects")
        if not headers and not replace:
            raise ValueError(f"{where}: expected headers or replace")
        if any(len(str(placeholder)) < MIN_PLACEHOLDER for placeholder in replace):
            raise ValueError(f"{where}.replace: placeholders need {MIN_PLACEHOLDER} characters or more")
        targets = tuple(raw.get("in") or ("headers",))
        if any(target not in TARGETS for target in targets):
            raise ValueError(f"{where}.in: expected some of {', '.join(TARGETS)}")
        values = resolve(headers, env, f"{where}.headers")
        replacements = resolve(replace, env, f"{where}.replace")
        rules.append(
            Rule(
                host=host.lower().rstrip("."),
                paths=tuple(re.compile(p) for p in raw.get("paths") or []),
                methods=tuple(m.upper() for m in raw.get("methods") or DEFAULT_METHODS),
                headers=values,
                replace=replacements,
                targets=targets,
                insecure=bool(raw.get("insecure", False)),
            )
        )
    return rules


def parse_document(document: object, env: dict[str, str] | None) -> tuple[list[Rule], list[CacheRule]]:
    """Rules and the cache rules of the optional `cache` list."""
    rules = parse_rules(document, env)
    return rules, parse_cache_rules(document.get("cache") or [])


def load_rules(path: str, env: dict[str, str]) -> tuple[list[Rule], list[CacheRule]]:
    with open(path, encoding="utf-8") as file:
        return parse_document(json.load(file), env)


def fetch_rules(url: str, token: str) -> tuple[list[Rule], list[CacheRule]]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as response:
        return parse_document(json.load(response), None)


class Egress:
    def __init__(self) -> None:
        self.file_rules: list[Rule] = []
        self.url_rules: list[Rule] = []
        self.file_cache_rules: list[CacheRule] = []
        self.url_cache_rules: list[CacheRule] = []
        self.cache: Cache | None = None
        self.wake = asyncio.Event()
        self.refreshed_at = 0.0
        self.task: asyncio.Task | None = None

    @property
    def rules(self) -> list[Rule]:
        return self.file_rules + self.url_rules

    def load(self, loader) -> None:
        loader.add_option("egress_rules", str, "", "JSON file with rules.")
        loader.add_option("egress_rules_url", str, "", "URL that serves rules as JSON.")
        loader.add_option("egress_rules_refresh", int, 60, "Seconds between reads of the URL.")
        try:
            self.cache = Cache.from_env(dict(os.environ))
        except OSError as error:
            logging.warning(f"egress: download cache disabled: {error}")

    def update_cache_rules(self) -> None:
        if self.cache:
            self.cache.extra_rules = self.file_cache_rules + self.url_cache_rules

    def configure(self, updated: set[str]) -> None:
        if "egress_rules" in updated:
            path = ctx.options.egress_rules
            self.file_rules, self.file_cache_rules = load_rules(path, dict(os.environ)) if path else ([], [])
            self.update_cache_rules()
            if path:
                self.report("file", self.file_rules)

    def report(self, source: str, rules: list[Rule]) -> None:
        hosts = sorted({rule.host for rule in rules})
        logging.info(f"egress: {len(rules)} {source} rules for {', '.join(hosts) or 'no hosts'}")

    async def refresh(self) -> None:
        url = ctx.options.egress_rules_url
        self.refreshed_at = time.monotonic()
        try:
            rules, cache_rules = await asyncio.to_thread(fetch_rules, url, os.environ.get("EGRESS_RULES_TOKEN", ""))
        except Exception as error:
            logging.warning(f"egress: reading rules from {url} failed, keeping the previous ones: {error}")
            return
        if cache_rules != self.url_cache_rules:
            self.url_cache_rules = cache_rules
            self.update_cache_rules()
        if rules != self.url_rules:
            self.url_rules = rules
            self.report("URL", rules)

    async def poll(self) -> None:
        while True:
            await self.refresh()
            try:
                await asyncio.wait_for(self.wake.wait(), ctx.options.egress_rules_refresh)
            except TimeoutError:
                pass
            self.wake.clear()
            gap = MIN_REFRESH_GAP - (time.monotonic() - self.refreshed_at)
            if gap > 0:
                await asyncio.sleep(gap)

    async def running(self) -> None:
        if ctx.options.egress_rules_url and self.task is None:
            self.task = asyncio.create_task(self.poll())
        if self.cache:
            await self.cache.running()

    def done(self) -> None:
        if self.task:
            self.task.cancel()
        if self.cache:
            self.cache.done()

    def tls_clienthello(self, data: tls.ClientHelloData) -> None:
        # Intercept only when the tunnel's destination and the SNI both name a rule host, so a
        # client cannot point SNI at a rule host while tunneling to a server of its own.
        address = data.context.server.address
        hosts = {address[0] if address else "", data.client_hello.sni or ""} - {""}
        if not hosts or not all(self.names(host) for host in hosts):
            data.ignore_connection = True

    def names(self, host: str) -> bool:
        return any(rule.matches_host(host) for rule in self.rules) or bool(self.cache and self.cache.names(host))

    async def request(self, flow: http.HTTPFlow) -> None:
        headers_set = False
        credentialed = False
        for rule in self.rules:
            if not rule.matches(flow.request):
                continue
            changed = False
            if rule.headers and not headers_set:
                for name, value in rule.headers.items():
                    flow.request.headers[name] = value
                headers_set = changed = True
            if rule.replace and rule.substitute(flow.request):
                changed = True
            credentialed = credentialed or changed
            if changed and rule in self.url_rules:
                flow.metadata["egress"] = True
        if self.cache:
            await self.cache.request(flow, credentialed)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        if self.cache:
            self.cache.responseheaders(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        if self.cache:
            self.cache.error(flow)

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.metadata.get("egress") and flow.response and flow.response.status_code in (401, 403):
            self.wake.set()


addons = [Egress()]
