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
  groups?: string[] // config groups, e.g. 'games'
  repos?: string[] // path globs, optionally forge-qualified: 'work:games/slots/**'
}
```

Actions: `repos:read`, `audits:read`, `audits:run`, `audits:allowlist`, `releases:read`, `releases:run`, `settings:read`, `settings:write`, `credentials:read`, `credentials:write`, `knowledge:read`, `knowledge:write`, `ai:read`, `ai:admin` (includes `ai:read` for the AI usage views), `users:read`, `users:invite`, `users:write`, `audit:read` (the tamper-evident audit log; only checked globally); `*` allows all.

## Checks

| Function                         | Answers                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `can(principal, action, target)` | May the principal do `action` on a repository (`{ kind: 'repo', repo }`), on an object owned by a scope such as a credential or setting (`{ kind: 'scope', scope }`), or on the whole system (`{ kind: 'global' }`, needs a grant with `all`)? |
| `scopeCoversRepo(scope, repo)`   | Does the scope include the repository (group membership comes from the config)?                                                                                                                                                                |
| `scopeWithin(inner, outer)`      | Is everything `inner` covers also covered by `outer`?                                                                                                                                                                                          |
| `grantsWithin(grants, parent)`   | Do `grants` give nothing beyond `parent`?                                                                                                                                                                                                      |
| `canDelegate(principal, grants)` | May the principal hand these grants to someone else (invites, later API tokens)? Needs `users:invite` over each scope and the grants within their own.                                                                                         |

`scopeWithin` is exact for literal paths and `prefix/**` globs. For other glob shapes it cannot prove containment and answers `false`, so delegation can only ever be too strict, never too generous.

## Examples

- An admin of `games/**` with `*` can invite an admin of `games/slots/**`, but not of `tools/**` or everything.
- A credential scoped to `{ groups: ['games'] }` is visible to anyone with `credentials:read` on a scope covering the `games` group, or on everything.
- `rootPrincipal(provider)` has `*` on everything; the `none` and `password` providers use it.

`grantSchema` and `scopeSchema` validate grants from config, API input or storage.
