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

A repository can sit in several groups, so groups work as tags. A group key may name a subgroup one level below a root group (`shapes.round` under `shapes`); a repository in a subgroup is always in its parent too, and its `RepoTarget.groups` holds both. A `groups` entry is a group name or a list of groups the repository must belong to all at once; entries combine with OR. `{ groups: ['tools', ['frontend', 'storefront']] }` covers every repository of `tools` and the repositories that are both `frontend` and `storefront`.

Actions: `repos:read`, `audits:read`, `audits:run`, `analyses:read`, `analyses:run`, `catalog:read` (implied by `analyses:read` on the same scope), `releases:read`, `releases:run`, `tasks:run` (approve [write tasks](../../write-task/docs/README.md) that push a branch and open a merge request on the repository; for another team's repository the grant must cover it explicitly, see the server's agent tasks), `settings:read`, `settings:write`, `credentials:read`, `credentials:write`, `knowledge:read`, `knowledge:write`, `ai:read`, `ai:admin` (includes `ai:read` for the AI usage views), `users:read`, `users:invite`, `users:write`, `audit:read` (the tamper-evident audit log; only checked globally); `*` allows all.

`catalog:read` covers derived, low-sensitivity metadata about a repository: its package and version inventory, public API, stack and tool versions, usage counts and knowledge entries marked `shared`. It never covers findings, audits, jobs, releases, review output or code. The server widens it across teams under the _Cross-team catalog_ setting; see `apps/server/docs/README.md`.

## Checks

| Function                         | Answers                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `can(principal, action, target)` | May the principal do `action` on a repository (`{ kind: 'repo', repo }`), on an object owned by a scope such as a credential or setting (`{ kind: 'scope', scope }`), or on the whole system (`{ kind: 'global' }`, needs a grant with `all`)? |
| `scopeCoversRepo(scope, repo)`   | Does the scope include the repository (group membership comes from the config)?                                                                                                                                                                |
| `scopeWithin(inner, outer)`      | Is everything `inner` covers also covered by `outer`?                                                                                                                                                                                          |
| `grantsWithin(grants, parent)`   | Do `grants` give nothing beyond `parent`?                                                                                                                                                                                                      |
| `canDelegate(principal, grants)` | May the principal hand these grants to someone else (invites, later API tokens)? Needs `users:invite` over each scope and the grants within their own.                                                                                         |

### Subgroups

`groups.ts` (also `@holtkeeper/access/groups`, so the web app can import it without the schemas) reads the group tree from the keys alone:

| Helper                | Answers                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GROUP_KEY_PATTERN`   | `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$`: a root group or one subgroup level                                                |
| `parentGroup(key)`    | the parent of a subgroup, `undefined` for a root group                                                                     |
| `rootGroup(key)`      | the root group (`key` itself for a root group)                                                                             |
| `isSubgroup(key)`     | whether `key` names a subgroup                                                                                             |
| `groupLineage(key)`   | the key and its ancestors, deepest first: `['shapes.round', 'shapes']`                                                     |
| `leafGroups(groups)`  | the list without any group that has a descendant in it, for naming a repository's teams                                    |
| `outerGroups(groups)` | the list without any group whose ancestor is in it, for naming OR-ed scope entries (a parent already covers its subgroups) |

`scopeSpecificity` counts a group entry by its ancestor closure: `['shapes']` ranks 1, `['shapes.round']` 1.5 (like a two-group intersection), `[['shapes.round', 'tools']]` 2 − 1/3. A subgroup entry always beats its parent's. Group entries are OR-ed, so a scope ranks by its broadest entry: `['shapes', 'shapes.round']` ranks 1, like `['shapes']`, and ties with it go to the newer entry. `scopeWithin` treats an entry as within a candidate when every group of the candidate is in the entry's closure, so an admin of `shapes` can delegate `shapes.round`, and an admin of `shapes.round` cannot delegate `shapes` or `shapes.flat`. `scopeCoversRepo` needs no change: a repository's groups already hold the full lineage.

`groupsMatch(entries, memberOf)` checks a group list against the groups of one repository; `groupNames(entries)` lists every group named, for validating references. `scopeSpecificity(scope)` ranks scopes for picking the entry that applies when several cover a repository: everything (0) < groups (1) < group intersections (between 1 and 2, more groups rank higher) < path globs (2) < exact paths (3). Settings, merge request policies, knowledge and AI budgets all use it.

`scopeWithin` treats an intersection as covered by any entry that asks for a subset of its groups: `['frontend', 'storefront']` is within `['frontend']`, never the other way round. It is exact for literal paths and `prefix/**` globs. For other glob shapes it cannot prove containment and answers `false`, so delegation can only ever be too strict, never too generous.

## Roles

`roleOf(grants)` reads a set of grants as one coarse `Role` that every surface shows the same way (the setup link page, Account, the Forbidden card): `admin` for `*` on every repository (`scope.all`), `viewer` when every action only reads, `none` without grants and `custom` otherwise. It lives in `@holtkeeper/access/roles` too, so the web app can import it without the schemas.

## Examples

- An admin of `games/**` with `*` can invite an admin of `games/app/**`, but not of `tools/**` or everything.
- An admin of `{ groups: ['frontend'] }` can invite an admin of `{ groups: [['frontend', 'storefront']] }`, but not of `storefront` alone.
- An admin of `{ groups: ['shapes'] }` can invite an admin of `{ groups: ['shapes.round'] }`, never the other way round.
- A credential scoped to `{ groups: ['games'] }` is visible to anyone with `credentials:read` on a scope covering the `games` group, or on everything.
- `rootPrincipal(provider)` has `*` on everything; the `none` and `password` providers use it.

`grantSchema`, `scopeSchema` and `groupMatchSchema` validate grants, scopes and group lists from config, API input or storage.
