# @holtkeeper/access

Who may do what, on which repositories. Every auth provider produces a `Principal` with grants; every route checks them with `can`. Nothing here knows how people sign in. The model behind teams and paths is described in [docs/teams-and-paths.md](../../../docs/teams-and-paths.md).

## Model

```ts
interface Grant {
  scope: Scope
  actions: (Action | '*')[]
}

interface Scope {
  all?: boolean // everything, including global objects
  teams?: string[] // repositories these teams own
  repos?: string[] // path patterns, optionally forge-qualified: 'work:acme/**', 'acme/*/web'
}
```

Entries of a scope combine with OR. A `repos` pattern is a `Bun.Glob` over the repository path: `*` stays within one folder, `**` crosses folders and needs at least one segment when it ends the pattern (`acme/**` does not match `acme` itself). A pattern without a forge prefix matches every forge.

`RepoTarget` is a repository with its owner teams (`{ forge, path, teams }`); the config resolves them (`resolveRepo` of `@holtkeeper/core`).

Actions: `repos:read`, `audits:read`, `audits:run`, `analyses:read`, `analyses:run`, `catalog:read` (implied by `analyses:read` on the same scope), `releases:read`, `releases:run`, `tasks:run` (approve [write tasks](../../write-task/docs/README.md) that push a branch and open a merge request on the repository; for another team's repository the grant must cover it explicitly, see the server's agent tasks), `settings:read`, `settings:write`, `credentials:read`, `credentials:write`, `knowledge:read`, `knowledge:write`, `ai:read`, `ai:admin` (includes `ai:read` for the AI usage views), `users:read`, `users:invite`, `users:write`, `audit:read` (the tamper-evident audit log; only checked globally); `*` allows all.

`catalog:read` covers derived, low-sensitivity metadata about a repository: its package and version inventory, public API, stack and tool versions, usage counts and knowledge entries marked `shared`. It never covers findings, audits, jobs, releases, review output or code. The server widens it across teams under the _Cross-team catalog_ setting; see `apps/server/docs/README.md`.

## Checks

| Function                               | Answers                                                                                                                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `can(principal, action, target)`       | May the principal do `action` on a repository (`{ kind: 'repo', repo }`), on an object owned by a scope such as a credential or setting (`{ kind: 'scope', scope }`), or on the whole system (`{ kind: 'global' }`, needs a grant with `all`)? |
| `scopeCoversRepo(scope, repo)`         | Does the scope include the repository?                                                                                                                                                                                                         |
| `scopeWithin(inner, outer, teams?)`    | Is everything `inner` covers also covered by `outer`? Never too generous.                                                                                                                                                                      |
| `scopeSpecificity(scope)`              | How narrowly the scope targets repositories, for picking the entry that applies when several cover one.                                                                                                                                        |
| `grantsWithin(grants, parent, teams?)` | Do `grants` give nothing beyond `parent`?                                                                                                                                                                                                      |
| `canDelegate(principal, grants)`       | May the principal hand these grants to someone else (invites, later API tokens)? Needs `users:invite` over each scope and the grants within their own.                                                                                         |

**Containment.** `scopeWithin` compares path patterns segment by segment (`patternWithin`): `acme/*/web` is within `acme/**`, `acme/round/web` within `acme/*/web`, `acme/**` within neither `acme/*/web` nor `acme/round/**`. It agrees with `Bun.Glob` on every pattern built from literal segments, `*` and `**`; a segment with a partial wildcard (`app-*`, `{a,b}`) is only within an equal segment or one that matches it literally, so delegation can be too strict but never too generous. A team is within a scope naming it. When `teams` (or `principal.teamDefs`) knows a team's patterns, a pattern inside the team's `owns` is within `{ teams: [key] }` (for a team with `exclude`, only exact paths it owns), and a team is within a scope that holds all of its `owns`. Without the patterns, a team grant covers repositories and objects scoped to that team only.

**Specificity.** Everything (0) < teams (1) < path globs (2, plus 0.1 per leading literal folder, at most 2.9: `acme/round/**` 2.2 outranks `acme/**` 2.1) < exact paths (3). Entries are OR-ed, so a scope ranks by its broadest entry; an empty scope ranks 0. Settings, merge request policies, knowledge and AI budgets use it.

## Paths

`paths.ts` (also `@holtkeeper/access/paths`, no dependencies, for the web app) holds the path tree. Folders are derived: every prefix of a repository path is one; nothing about them is stored.

| Helper                           | Answers                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `splitPattern(pattern)`          | `{ forge?, glob }`                                                                     |
| `globMatches(glob, path)`        | whether a forge-less glob matches a path, like `Bun.Glob` but browser-safe             |
| `patternMatches(p, forge, path)` | whether the pattern matches the repository                                             |
| `patternWithin(inner, outer)`    | containment of two patterns, as above                                                  |
| `literalDepth(pattern)`          | how many leading folders the pattern pins (`acme/round/**` → 2)                        |
| `isExactPattern(pattern)`        | whether it names one path                                                              |
| `pathAncestors(path)`            | the folders holding a path, deepest first: `a/b/c` → `['a/b', 'a']`                    |
| `parentFolder(path)`             | the folder directly holding a path                                                     |
| `commonFolder(paths)`            | the deepest folder holding every path                                                  |
| `folderPattern(folder, forge?)`  | `work:acme/round/**`                                                                   |
| `sharedShape(paths)`             | one pattern for paths differing in exactly one segment: `['a/x/c', 'a/y/c']` → `a/*/c` |

## Teams

`teams.ts` (also `@holtkeeper/access/teams`) turns team definitions into ownership and grants.

- `TEAM_KEY_PATTERN` (`^[a-z][a-z0-9-]*$`), `teamKeySchema`, `teamMemberSchema`, `pathPatternSchema`.
- `TeamDefinition { owns, exclude?, consumes?, members? }`, `TeamMember { id, role: 'maintainer' | 'member' }`. A member's `id` is a principal id or an e-mail, compared case-insensitively.
- `teamOwns(team, forge, path)`, `teamsOwning(teams, forge, path)` — the owners of a repository, in the order of `teams`.
- `teamRoleOf(team, principal)`, `teamsOfPrincipal(teams, principal)`.
- `teamGrants(teams, principal)` — what membership gives: `*` on `{ teams: [key] }` for maintainers, `MEMBER_ACTIONS` there for members (read and run: repositories, audits, analyses, releases, tasks, knowledge, settings read), and `CONSUMER_ACTIONS` (`repos:read`, `analyses:read`, `releases:read`, `knowledge:read`) on the team's `consumes` patterns for both. The server adds them to the principal's own grants and sets `principal.teamDefs`, so team grants also cover path-scoped objects inside the team.

## Roles

`roleOf(grants)` reads a set of grants as one coarse `Role` that every surface shows the same way (the setup link page, Account, the Forbidden card): `admin` for `*` on every repository (`scope.all`), `viewer` when every action only reads, `none` without grants and `custom` otherwise. It lives in `@holtkeeper/access/roles` too, so the web app can import it without the schemas.

## Examples

- An admin of `games/**` with `*` can invite an admin of `games/app/**` or `games/*/web`, but not of `tools/**` or everything.
- A maintainer of team `gizmo` (owning `acme/round/**`) can write settings scoped to `work:acme/round/web` and invite admins of `acme/round/web/**`, but not of `acme/**`.
- A member of `gizmo` that consumes `acme/shared/**` reads those repositories but cannot run releases there.
- A credential scoped to `{ teams: ['games'] }` is visible to anyone with `credentials:read` on a scope covering that team, or on everything.
- `rootPrincipal(provider)` has `*` on everything; the `none` and `password` providers use it.

`grantSchema` and `scopeSchema` validate grants and scopes from config, API input or storage.
