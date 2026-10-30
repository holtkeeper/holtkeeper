"""mitmproxy addon that adds credentials to matching requests, so clients never hold them.

Rules come from a JSON file (option `egress_rules`), from a URL (option `egress_rules_url`, read
with `EGRESS_RULES_TOKEN` as a bearer token), or both. Header values in the file may reference the
proxy's own environment as `${NAME}`; a missing variable fails the start. URL rules are taken
literally and re-read every `egress_rules_refresh` seconds, and at once when an upstream answers a
request with added credentials with 401 or 403; a failed read keeps the previous rules. TLS to hosts
no rule names is tunneled untouched, so clients only need to trust the proxy CA for those hosts.
"""

import asyncio
import json
import logging
import os
import re
import time
import urllib.request
from dataclasses import dataclass
from string import Template

from mitmproxy import ctx, http, tls

DEFAULT_METHODS = ("GET", "HEAD")
MIN_REFRESH_GAP = 5.0


@dataclass(frozen=True)
class Rule:
    host: str
    paths: tuple[re.Pattern[str], ...]
    methods: tuple[str, ...]
    headers: dict[str, str]
    insecure: bool

    def matches_host(self, host: str) -> bool:
        host = host.lower().rstrip(".")
        if self.host.startswith("*."):
            return host.endswith(self.host[1:])
        return host == self.host

    def matches(self, request: http.Request) -> bool:
        if request.scheme != "https" and not self.insecure:
            return False
        if request.method.upper() not in self.methods:
            return False
        if not self.matches_host(request.host):
            return False
        return not self.paths or any(p.search(request.path) for p in self.paths)


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
        headers = raw.get("headers")
        if not isinstance(headers, dict) or not headers:
            raise ValueError(f"{where}.headers: expected at least one header")
        try:
            values = {
                str(k): str(v) if env is None else Template(str(v)).substitute(env)
                for k, v in headers.items()
            }
        except KeyError as missing:
            raise ValueError(f"{where}.headers: environment variable {missing} is not set") from None
        except ValueError as error:
            raise ValueError(f"{where}.headers: {error}") from None
        rules.append(
            Rule(
                host=host.lower().rstrip("."),
                paths=tuple(re.compile(p) for p in raw.get("paths") or []),
                methods=tuple(m.upper() for m in raw.get("methods") or DEFAULT_METHODS),
                headers=values,
                insecure=bool(raw.get("insecure", False)),
            )
        )
    return rules


def load_rules(path: str, env: dict[str, str]) -> list[Rule]:
    with open(path, encoding="utf-8") as file:
        return parse_rules(json.load(file), env)


def fetch_rules(url: str, token: str) -> list[Rule]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as response:
        return parse_rules(json.load(response), None)


class Egress:
    def __init__(self) -> None:
        self.file_rules: list[Rule] = []
        self.url_rules: list[Rule] = []
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

    def configure(self, updated: set[str]) -> None:
        if "egress_rules" in updated:
            path = ctx.options.egress_rules
            self.file_rules = load_rules(path, dict(os.environ)) if path else []
            if path:
                self.report("file", self.file_rules)

    def report(self, source: str, rules: list[Rule]) -> None:
        hosts = sorted({rule.host for rule in rules})
        logging.info(f"egress: {len(rules)} {source} rules for {', '.join(hosts) or 'no hosts'}")

    async def refresh(self) -> None:
        url = ctx.options.egress_rules_url
        self.refreshed_at = time.monotonic()
        try:
            rules = await asyncio.to_thread(fetch_rules, url, os.environ.get("EGRESS_RULES_TOKEN", ""))
        except Exception as error:
            logging.warning(f"egress: reading rules from {url} failed, keeping the previous ones: {error}")
            return
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

    def done(self) -> None:
        if self.task:
            self.task.cancel()

    def tls_clienthello(self, data: tls.ClientHelloData) -> None:
        # Intercept only when the tunnel's destination and the SNI both name a rule host, so a
        # client cannot point SNI at a rule host while tunneling to a server of its own.
        address = data.context.server.address
        hosts = {address[0] if address else "", data.client_hello.sni or ""} - {""}
        if not hosts or not all(self.names(host) for host in hosts):
            data.ignore_connection = True

    def names(self, host: str) -> bool:
        return any(rule.matches_host(host) for rule in self.rules)

    def request(self, flow: http.HTTPFlow) -> None:
        for rule in self.rules:
            if rule.matches(flow.request):
                for name, value in rule.headers.items():
                    flow.request.headers[name] = value
                flow.metadata["egress"] = rule in self.url_rules
                return

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.metadata.get("egress") and flow.response and flow.response.status_code in (401, 403):
            self.wake.set()


addons = [Egress()]
