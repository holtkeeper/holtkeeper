# Teams and paths

Status: accepted, in progress. Replaces config groups and subgroups.

## Why

Groups mixed three different questions in one object: where a repository lives, who owns it, and which repositories are alike. With a fleet of a hundred and more repositories this broke down:

- the forge already arranges repositories in folders (`acme/round-game/frontend-libs`), and people think in those folders, so a second tree of groups had to be kept in sync by hand;
- a shared library is owned by several teams, one team owns several products, and some teams only consume repositories they are not responsible for; one root group per team cannot say any of that;
- `acme/round-game/game-frontend` and `acme/square-game/game-frontend` share most of their code, but a rule set on their nearest common group lands on all of `acme`, backends included.

## Model: two independent axes

| Axis                        | Defined by                                                               | Used for                                                                             |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Paths** (the folder tree) | The forge: every prefix of a repository path is a folder. Nothing stored | Navigation, settings, access, automation patterns and rule scopes                    |
| **Teams**                   | Panel documents: members, `owns` and `consumes` path patterns            | Access through membership, responsibility (Inbox, notifications), team process rules |

Settings never depend on teams, so no resolution is ambiguous. Alike repositories in different folders meet through a pattern (`acme/*/game-frontend`), never through a stored similarity cluster.

### Paths

A pattern is a `Bun.Glob` over the repository path, optionally forge-qualified: `acme/**`, `work:acme/round-game/*`, `acme/*/game-frontend`. A bare pattern matches every forge. The tree is derived from the repository listing; the forge id is the root and is hidden while only one forge is configured.

- `Scope.repos` keeps holding path patterns (the field name stays, stored scopes stay valid).
- `scopeSpecificity` ranks a pattern by its literal segments, so a deeper folder always wins: everything (0) < team (1) < pattern (2 + depth / 10, at most 2.9) < exact path (3). A scope ranks by its broadest entry.
- `scopeWithin` decides containment segment by segment (`*` is one segment, `**` any number), so an admin of `acme/**` can delegate `acme/*/game-frontend`. Segments with partial wildcards (`app-*`, `{a,b}`) are only within an equal segment or a pattern matching them literally; it can be too strict, never too generous.
- **Fleet.** Holtkeeper works on the repositories teams own or consume plus the folders a forge document includes (`include` / `exclude` on the forge, `fleetPatterns`). Group listings no longer define what exists.
- Repository traits stay keyed by path glob; traits on `acme/round-game/**` are folder traits.
- Moving a project on the forge changes its path. Scopes keyed by path follow it only when the forge reports the move; until then, an exact-path scope stops covering the moved repository (it never covers another one).

### Teams

```ts
interface TeamDocument {
  title?: string
  owns: string[] // path patterns the team is responsible for
  exclude: string[] // patterns cut out of `owns`
  consumes: string[] // path patterns the team reads but does not answer for
  members: { id: string; role: 'maintainer' | 'member' }[] // principal id or e-mail
}
```

- A repository's teams (`RepoTarget.teams`) are every team whose `owns` matches it and whose `exclude` does not. Shared libraries have several; repositories nobody owns have none.
- `Scope.teams` covers the repositories of those teams. There are no intersections and no subgroups: folders are what subgroups were, and patterns are what intersections were.
- Membership turns into grants when a principal signs in (`teamGrants`): maintainers get `*` on `{ teams: [team] }`, members the day-to-day actions there (`MEMBER_ACTIONS`: read and run audits, analyses, releases and tasks, read settings, AI usage and people, read and propose knowledge), and every member the read actions on `consumes` (`CONSUMER_ACTIONS`: repositories, analyses, releases, knowledge). Personal grants still exist for administrators and exceptions.
- Maintainers may edit their team's title and members; `owns` and `consumes` widen access, so only global `settings:write` changes them.
- Cross-team rules ("same team", the cross-team catalog) compare owner teams. A consumer is never treated as the same team.
- Settings are scoped by paths and `all` only in the panel; a team scope stays valid for settings but the panel offers folders first, because a repository with two owner teams would otherwise get two conflicting values.

## Rules and learnings

Rules follow the AGENTS.md / Copilot / Cursor convention ([@holtkeeper/rules](../packages/rules/docs/README.md)):

- **Repository rules files** (`AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, Copilot and Cursor rules, ...) are scoped by their place in the repository: a nested `AGENTS.md` applies under its folder, frontmatter globs (`applyTo`, `globs`, `paths`) to matching files.
- **Rules** written in the panel take a `Scope` like settings: everything, teams (a team is its set of repositories) or path patterns. Optional `files` globs narrow a rule to tasks touching those files; `agents` to reviews, tasks, chat or release notes. Team rules hold process (how the team reviews, commits, releases); code rules belong in the repository or on path patterns.
- **Learnings** start scoped to the repository that taught them (`{ repos: [forge:path] }`), optionally with `files`; people may widen the scope by hand. Nothing is promoted automatically.

Who may edit a rule or decide a learning is `knowledge:write` over its scope. Applicability is deterministic: scope, files and agent, then one budget; nothing depends on similarity search.

## Phases

1. **Contracts**: `access` (teams, path containment, specificity, team grants, path helpers), `core` (team documents, triggers by teams and patterns), `managed-config`.
2. **Everything else moves**: store, settings, jobs, rules, server, web. Groups and subgroups are deleted, not shimmed.
3. **Rules and learnings** replace the earlier knowledge base (families, folder spaces, placement of lessons, vectors and neighbour knowledge were removed): see [Rules](../packages/rules/docs/README.md).

Data already stored under groups is converted once outside the code base (group keys to team keys, subgroups to folder patterns); the code keeps no compatibility layer.
