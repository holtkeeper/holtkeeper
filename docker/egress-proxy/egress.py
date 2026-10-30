"""mitmproxy addon that adds credentials to matching requests, so clients never hold them.

Rules come from a JSON file (option `egress_rules`). Header values may reference the proxy's own
environment as `${NAME}`; a missing variable fails the start. TLS to hosts no rule names is tunneled
untouched, so clients only need to trust the proxy CA for the hosts it adds credentials for.
"""

import json
import logging
import os
import re
from dataclasses import dataclass
from string import Template

from mitmproxy import ctx, http, tls

DEFAULT_METHODS = ("GET", "HEAD")


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


def parse_rules(document: object, env: dict[str, str]) -> list[Rule]:
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
            values = {str(k): Template(str(v)).substitute(env) for k, v in headers.items()}
        except KeyError as missing:
            raise ValueError(f"{where}.headers: environment variable {missing} is not set") from None
        except ValueError as error:
            raise ValueError(f"{where}.headers: {error}") from None
        rules.append(
            Rule(
                host=host.lower().rstrip("."),
                paths=tuple(re.compile(p) for p in raw.get("paths", [])),
                methods=tuple(m.upper() for m in raw.get("methods", DEFAULT_METHODS)),
                headers=values,
                insecure=bool(raw.get("insecure", False)),
            )
        )
    return rules


def load_rules(path: str, env: dict[str, str]) -> list[Rule]:
    with open(path, encoding="utf-8") as file:
        return parse_rules(json.load(file), env)


class Egress:
    def __init__(self) -> None:
        self.rules: list[Rule] = []

    def load(self, loader) -> None:
        loader.add_option("egress_rules", str, "/etc/egress/rules.json", "JSON file with the rules.")

    def configure(self, updated: set[str]) -> None:
        if "egress_rules" in updated:
            self.rules = load_rules(ctx.options.egress_rules, dict(os.environ))
            hosts = sorted({rule.host for rule in self.rules})
            logging.info(f"egress: {len(self.rules)} rules for {', '.join(hosts) or 'no hosts'}")

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
                return


addons = [Egress()]
