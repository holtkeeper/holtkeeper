# Policies

Part of the [@holtkeeper/server](README.md) docs.

Server side of Settings › Policies: policy drafts saved as one change, the license policy, the allowlist rules and the commit convention check. Setting resolution and the allowlist rules live in `setting-rules.ts`.

## `POST /api/settings/draft`

`PolicyDraftInput { changes }`, 1 to 50 changes, each `{ op: 'put', id?, key, scope, value }` or `{ op: 'remove', id }`. Every change is checked first, exactly as `PUT /api/settings` and `DELETE /api/settings/:id` check one (known, non-retired key; `global` keys only for everything; `settings:write` on the new and the stored scope; the key's schema; the allowlist rules below), and nothing is stored unless all pass: 400, 403 or 404 for the first that fails. A draft may change each entry once (400 otherwise) and may not hold secret settings (400: save those on their own). Then puts are stored, removals deleted, and one audit event `setting.draft` is written: target the first saved (or removed) entry, `changes` of every entry with fields prefixed `<key>#<id>.`, details `{ keys, saved, removed }`. Home lists it as "Saved N setting changes at once". Answers `PolicyDraftResult { saved: SettingView[], removed: string[] }`.

## Allowlist rules

`audit.allowlistPolicy` (`{ maxDays?, requireReason }`, default `{ requireReason: true }`) limits `audit.allowlist` entries. The policy that governs entries stored with a scope is the strictest combination of every `audit.allowlistPolicy` entry whose scope contains that scope: the smallest `maxDays` and a required reason when any of them asks for one (`allowlistPolicyFor`). A narrower scope can tighten the organization's rules but never loosen them. A draft that also changes policies is checked against the stored policies plus the drafted ones, by the same rule.

- `PUT /api/settings` and `POST /api/settings/draft` check every allowlist entry that is new or whose reason or expiry changed (entries are matched by advisory and package): under `requireReason` a blank reason is refused; with `maxDays` the entry needs an expiry no later than today plus `maxDays`. 400 names the entry and the latest allowed day. Unchanged entries pass, so tightening the policy never blocks unrelated edits.
- `POST /api/audits/allowlist/renew` checks the renewed entry the same way. It takes an optional `reason` that replaces the stored one; the audit event's `changes` carry `expires` and `reason`.

## License policy

`analyzers.licenses` options are the `licenses` analyzer's (see [@holtkeeper/licenses](../../../packages/licenses/docs/README.md)), including `review`, `devDependencies` and `exceptions`. `GET /api/licenses` (and the `license_overview` tool) read the organization's entry, the newest scoped `{ all: true }` (`orgEntry`), and send `review`, `devDependencies` and `exceptions` along with the policy summary (`LicensePolicyRules`); repository rows count `excepted` packages.

## `POST /api/commit-conventions/check`

`CommitConventionsCheckInput { repo, message?, branch? }` (at least one of message and branch, else 400; `repo` as `forge:path` on a configured forge, else 400). Needs `analyses:read` on the repository, the same reach as the MCP tool. Reads the conventions through `commitConventionsReader` and checks them with `checkConventions`, the function `check_commit_message` uses. Answers `CommitConventionsCheckResult { ok, problems }`: each problem with `target`, `rule`, `message`, `severity` and `source`; `ok` when no problem is an `error`.

## Setting resolution for tools

`cascadeFor` and `applyingEntry` resolve a key for a repository as `GET /api/settings/resolve` does (most specific scope, then newest; `global` keys only from entries for everything). The MCP and chat tools that return settings use them: commit conventions and test id overrides in `tools/rules.ts`, the license policy in `tools/repos.ts` through `GET /api/licenses`'s overview.

## Tests

`test/policies.test.ts`: a draft over several keys with one audit event and its Home line, nothing stored when one change is refused or invalid, duplicate and unknown keys, allowlist rules on `PUT`, on a draft that changes the policy too and on renew, and the commit convention check with its permission and input errors.
