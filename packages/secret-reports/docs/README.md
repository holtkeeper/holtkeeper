# @holtkeeper/secret-reports

Lets AI agents connected over MCP report secrets (keys, tokens, passwords) that showed up in their sessions, so administrators rotate them. Agents report on their own: the tool description asks them to, so nobody needs to add anything to `AGENTS.md`. A report never holds the value, only the variable name, a mask and optionally a fingerprint.

**License.** This package and the parts of Holtkeeper that serve its reports are under the [Holtkeeper Secret Reports License](../LICENSE): the MIT License plus a **use condition**. An organization may keep the feature on only while reporting stays voluntary, reports (and the choice not to report) are never grounds for sanctions, and nobody tries to unmask anonymous reporters. The rest of Holtkeeper stays MIT. The feature is on by default; `server.secretReports: false` in `holtkeeper.config.ts` turns it off.

## How it fits together

1. **Per token, the person chooses** (Account › Connect agents): `named` (default), `anonymous` or `off`. Only the owner sees the choice; changing it is not audited, and administrators cannot set or read it.
2. **The agent calls `report_secret_exposure`** when a secret shows up (pasted, printed, read from a file, written by the agent). The toolset's server instructions and the tool description tell it to: report right away, masked, without naming people, then tell the user the secret needs rotating.
3. **The tool checks the report** before it reaches the server (below) and refuses anything that looks like it holds the value, without echoing it.
4. **The server checks that it is the organization's secret**: a fleet repository the token may read, or a service matching `security.secretReports › services` or a forge host. Anything else is refused and not stored.
5. **Administrators** (`credentials:read` on everything) see the reports under Supply › Secret reports, change status (`new`, `acknowledged`, `rotated`, `false-positive`) and notes with `credentials:write`, and get a Slack message per report in the channels of `security.secretReports`.

### Anonymous reports

An anonymous report stores nothing about its sender and only the **day** it arrived; the stored order does not follow arrival. Its call is not counted in MCP usage statistics (not even in totals), it writes no audit event, and its Slack post waits 5 to 30 minutes at random so the message time says nothing. What Holtkeeper cannot hide: the token's `lastUsedAt` (hourly), access logs of proxies in front of it, and small teams where only one person could have known the secret. The panel says so next to the choice.

## Public API

- Model: `secretKinds`, `exposureChannels`, `reportingModes` (`named`, `anonymous`, `off`), `DEFAULT_REPORTING_MODE` (`named`), `reportStatuses`, `isOpenStatus`, types `SecretReportInput`, `SecretReport`, `SecretReporter`.
- `secretReportsToolset(access): RegistryToolset` — toolset `security` with `report_secret_exposure` (`REPORT_TOOL`), `readOnly: false`, no `subject` (nothing about a call goes into statistics). `access` is a `SecretReportsAccess`: `mode` (`named` or `anonymous`, worded into the description and the answers), `submit(input)` → `SecretReportOutcome` (`reported`, `repeated` or `rejected` with a reason for the agent) and an optional `pageUrl`. Before `submit` the tool refuses:
  - text fields (`identifier`, `service`, `repo`, `circumstances`) that `looksLikeSecret`;
  - a `masked` that is not `<up to 4 characters>…(<length>)`, shows more than a quarter of the value, or any character of a password (`maskProblem`);
  - a fingerprint that is not 16 hex characters, or any fingerprint of a password;
  - reports with neither `repo` nor `service`.
    Refusals say which field failed and never repeat its content.
- `looksLikeSecret(text)` — well-known credential shapes (private keys, AWS, GitHub, GitLab, Slack, OpenAI-style and Stripe-style keys, Google API keys, MCP tokens, JWTs, URLs with a password, Slack webhooks) or long random-looking runs (mixed case and digits with high entropy, or 32+ hex digits). Ordinary passwords are not recognizable.
- `maskedPattern`, `maskProblem(masked, kind)`.
- `secretFingerprint(value)` — first 16 hex characters of the SHA-256 of the exact value (`printf %s "$VALUE" | shasum -a 256 | cut -c1-16`); `fingerprintPattern`.
- `matchKvSecrets({ address, token, mount, prefix?, namespace?, fingerprints, fetch?, onRead? })` → `KvMatch[]` — walks the latest version of every secret of an OpenBao or Vault KV v2 engine over HTTP and returns the fields whose value has one of the fingerprints. Values are hashed in memory and never leave the process; paths the token may not list or read are skipped. The CLI's `holtkeeper secrets match` uses it.
- `serviceName(service)`, `matchesService(service, patterns)` — `example.com` covers the host and its subdomains, `*.example.com` only subdomains, a name without dots exactly that name; case, scheme, port and path are ignored.
- `secretReportStore({ kv, now?, limit? })` → `SecretReportStore` (`submit`, `list`, `get`, `update`) over one key-value entry (`compareAndSet` when the store has it). An open report of the same kind, identifier, service, mask and fingerprint gets `repeats` raised instead of a new report. Beyond `limit` (default 1000) the oldest closed reports go first.
- Setting `security.secretReports` (`secretReportsDefinition`, `secretReportsSchema`, `secretReportsSettings(value)`, `secretReportsSettingKey`, global, section `Audit`): `services` (the organization's hosts and names besides forge hosts) and `channels` (Slack channel ids).
- `LICENSE_NAME`, `licenseText()` — the license with its use condition, which the panel shows next to the choice.

## Tests

`src/*.test.ts`: detection and masks, fingerprints and service matching, the store (named and anonymous reports, repeats, limits), the tool's refusals and the OpenBao walk with a fake `fetch`. The server's end-to-end behavior is in `apps/server/test/secret-reports.test.ts`.
