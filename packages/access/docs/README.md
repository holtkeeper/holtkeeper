# @holtkeeper/access

Who may do what, on which repositories. Every auth provider produces a `Principal` with grants; every route checks them with `can`. Nothing here knows how people sign in.

## Model

```ts
interface Grant {
  scope: Scope
  actions: (Action | '*')[]
}

interface Scope {
  all?: boolean // everything, including global objects
  groups?: GroupMatch[] // config groups: 'games', or ['frontend', 'storefront'] for both at once
  repos?: string[] // path globs, optionally forge-qualified: 'work:games/app/**'
}

type GroupMatch = string | string[]
```

A repository can sit in several groups, so groups work as tags. A `groups` entry is a group name or a list of groups the repository must belong to all at once; entries combine with OR. `{ groups: ['tools', ['frontend', 'storefront']] }` covers every repository of `tools` and the repositories that are both `frontend` and `storefront`.

Actions: `repos:read`, `audits:read`, `audits:run`, `audits:allowlist`, `releases:read`, `releases:run`, `settings:read`, `settings:write`, `credentials:read`, `credentials:write`, `knowledge:read`, `knowledge:write`, `ai:read`, `ai:admin` (includes `ai:read` for the AI usage views), `users:read`, `users:invite`, `users:write`, `audit:read` (the tamper-evident audit log; only checked globally); `*` allows all.

## Checks

| Function                         | Answers                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `can(principal, action, target)` | May the principal do `action` on a repository (`{ kind: 'repo', repo }`), on an object owned by a scope such as a credential or setting (`{ kind: 'scope', scope }`), or on the whole system (`{ kind: 'global' }`, needs a grant with `all`)? |
| `scopeCoversRepo(scope, repo)`   | Does the scope include the repository (group membership comes from the config)?                                                                                                                                                                |
| `scopeWithin(inner, outer)`      | Is everything `inner` covers also covered by `outer`?                                                                                                                                                                                          |
| `grantsWithin(grants, parent)`   | Do `grants` give nothing beyond `parent`?                                                                                                                                                                                                      |
| `canDelegate(principal, grants)` | May the principal hand these grants to someone else (invites, later API tokens)? Needs `users:invite` over each scope and the grants within their own.                                                                                         |

`groupsMatch(entries, memberOf)` checks a group list against the groups of one repository; `groupNames(entries)` lists every group named, for validating references. `scopeSpecificity(scope)` ranks scopes for picking the entry that applies when several cover a repository: everything (0) < groups (1) < group intersections (between 1 and 2, more groups rank higher) < path globs (2) < exact paths (3). Settings, merge request policies, knowledge and AI budgets all use it.

`scopeWithin` treats an intersection as covered by any entry that asks for a subset of its groups: `['frontend', 'storefront']` is within `['frontend']`, never the other way round. It is exact for literal paths and `prefix/**` globs. For other glob shapes it cannot prove containment and answers `false`, so delegation can only ever be too strict, never too generous.

## Examples

- An admin of `games/**` with `*` can invite an admin of `games/app/**`, but not of `tools/**` or everything.
- An admin of `{ groups: ['frontend'] }` can invite an admin of `{ groups: [['frontend', 'storefront']] }`, but not of `storefront` alone.
- A credential scoped to `{ groups: ['games'] }` is visible to anyone with `credentials:read` on a scope covering the `games` group, or on everything.
- `rootPrincipal(provider)` has `*` on everything; the `none` and `password` providers use it.

`grantSchema`, `scopeSchema` and `groupMatchSchema` validate grants, scopes and group lists from config, API input or storage.
