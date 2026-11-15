# @holtkeeper/vuln-triage

Picks the vulnerabilities that cannot wait out of an audit: malicious packages by rule, the rest by one AI call per advisory. The severity of a finding stays what OSV says; triage adds a separate verdict, "urgent or not", for the [urgent vulnerability alerts](../../../apps/server/docs/slack.md#urgent-vulnerability-alerts) of the server.

## Public API

- `isMalwareAdvisory({ id, aliases, summary? })` — `true` when an id or alias is an OSV `MAL-` id (the OpenSSF malicious-packages dataset, often without any severity, so audits show it as `unknown`) or the summary is GitHub's malware title (`Malicious code in some-lib`, `Malicious versions of …`).
- `fetchAdvisoryDetails(id, { fetch?, baseUrl?, timeoutMs? })` → `AdvisoryDetails { details?, cvss, cwes, published? }` — `GET https://api.osv.dev/v1/vulns/<id>` reduced to what triage reads: the description (at most 6000 characters), the CVSS vectors (`CVSS:…` scores only) and `database_specific.cwe_ids`. `undefined` when OSV does not know the id, answers with an error, does not answer within `timeoutMs` (default 10 s) or cannot be reached; never throws.
- `triageAdvisory(agent, input, { language?, signal? })` → `TriageVerdict { urgent, category, reason }` — one call (task kind `securityTriageTaskKind` = `security-triage`, tier `main`, no tools, an empty temporary directory, at most 3 turns). `input` is a `TriageInput`: advisory id, aliases, summary, package, ecosystem, severity, versions in use, fixed versions, how many repositories have it and optional `AdvisoryDetails`. `reason` is one or two sentences in `language` (default English). Rejects when the agent fails, a budget refuses the call or no structured answer comes back.
- `triageCategories` / `TriageCategory`: `malware`, `code-execution`, `code-or-secret-theft`, `auth-bypass`, `data-exposure`, `other`.
- Setting `security.alerts` (`securityAlertsSettingKey`, `securityAlertsDefinition`, global, section `Audit`, edited under Settings › Integrations), `securityAlertsSchema`, `securityAlertsSettings(value)` (defaults; a value that does not parse reports nothing), type `SecurityAlertsSettings`:

| Field           | Default                   | What it does                                                                                       |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `channels`      | none                      | Slack channel ids (`C…` or `G…`, at most 20); without any nothing is triaged or posted             |
| `severities`    | `['critical', 'unknown']` | Severities the AI triages; malware is reported at any severity                                     |
| `windowMinutes` | 30                        | How long a new urgent advisory waits for audits of other repositories before it is posted (0–1440) |
| `language`      | English                   | Language of the AI `reason`                                                                        |

## What counts as urgent

The prompt marks an advisory urgent only when, in a typical application using the package, it plausibly leads to serious harm without unusual preconditions: a malicious package or version (install scripts or code that steal or alter data, credentials, source code or the build), remote code execution, command injection or unsafe deserialization reachable from untrusted input, reading or changing source code, secrets or credentials, and authentication bypass or arbitrary file access in server code. Denial of service, ReDoS, prototype pollution without a known gadget, issues only reachable through developer tooling or a build step on trusted input, attacks that need control of code, configuration or the machine already, and theoretical issues are not urgent, whatever their score.

The verdict is a judgment, not a guarantee: callers keep every finding visible elsewhere and only use the verdict to decide whom to wake up.
