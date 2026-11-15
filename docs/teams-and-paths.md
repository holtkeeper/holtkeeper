# Teams, paths and knowledge that follows similar code

Status: accepted, in progress. Replaces config groups and subgroups.

## Why

Groups mixed three different questions in one object: where a repository lives, who owns it, and which repositories are alike. With a fleet of a hundred and more repositories this broke down:

- the forge already arranges repositories in folders (`acme/round-game/frontend-libs`), and people think in those folders, so a second tree of groups had to be kept in sync by hand;
- a shared library is owned by several teams, one team owns several products, and some teams only consume repositories they are not responsible for; one root group per team cannot say any of that;
- `acme/round-game/game-frontend` and `acme/square-game/game-frontend` share most of their code, but knowledge promoted to their nearest common group lands on all of `acme`, backends included.

## Model: three independent axes

| Axis                        | Defined by                                                               | Used for                                                                             |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Paths** (the folder tree) | The forge: every prefix of a repository path is a folder. Nothing stored | Navigation, settings and Guide inheritance, access and automation patterns           |
| **Teams**                   | Panel documents: members, `owns` and `consumes` path patterns            | Access through membership, responsibility (Inbox, notifications), team process rules |
| **Similarity**              | Families (confirmed clusters of alike repositories), stack facts, files  | Which knowledge and rules apply, retrieval, promotion of lessons                     |

Access never depends on similarity, and settings never depend on teams, so no resolution is ambiguous.

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

### Guide

Scope keys: `all` → `team:<id>` → `path:<forge>:<folder>` → `family:<id>` → `repo:<forge>:<path>`. A repository reads, most specific first: itself, its family, its folders deepest first, its owner teams (config order), then everything. Team blocks hold process rules (how the team reviews, commits, releases); code rules belong on folders and families.

## Knowledge

### Where an entry applies

`KnowledgeEntry.scope` stays the bound and the authority: who may accept and edit an entry (`knowledge:write` over the scope) and the widest set of repositories it can reach. A new optional `match` narrows it:

```ts
interface KnowledgeMatch {
  families?: string[] // only repositories of these families
  files?: string[] // only tasks touching these path globs (review: the diff; no file list: applies)
}
```

`selectForTask` keeps an entry when the scope covers the repository and the match holds. Applicability is deterministic and explained; nothing about it is left to similarity search.

### Placing lessons

`placeLessons` no longer promotes to the nearest common group. For a lesson that matches entries of sibling repositories it picks the narrowest description that holds all of them:

1. the same family → the family (`match.families`), scoped to the repository's owner teams;
2. paths of the same shape that differ in one segment → that pattern (`acme/*/game-frontend`);
3. a shared folder at least two segments deep → that folder (`acme/round-game/**`);
4. otherwise the owner team, and team process lessons always there.

### Retrieval

1. Filter: scope, match, task kind, package ranges (deterministic).
2. Rank: full text (existing) fused with vector similarity to the task (title, touched files, diff) by reciprocal rank fusion, then specificity and recency.
3. Budget and cite as before (`[kb:<id>]`).

Vectors also catch duplicates worded differently (cosine ≥ 0.9 next to the existing Jaccard test), which the keyword check misses, and in any language.

### Embeddings

- `@holtkeeper/embed` is the contract (`Embedder { id, model, dimensions, embed(texts, purpose) }`) with the vector helpers (cosine, encoding, content hash, reciprocal rank fusion) and a deterministic fake for tests. `@holtkeeper/embed-openai` is the first adapter: the OpenAI Embeddings format (`POST /v1/embeddings`), which OpenAI, Waibee Router and most gateways speak, so the AI credential already in the panel is enough and spend shows up next to the agents' in AI usage.
- The setting `knowledge.embeddings` turns vectors on and names the credential and the model (multilingual, e.g. `openai/text-embedding-3-small`). Off or failing, retrieval stays full text and nothing else changes.
- Vectors are stored per subject (`knowledge:<id>`), tagged with the embedder id and a hash of the embedded text; an edit or a model change re-embeds in the background.
- Similarity is computed in process over the deterministic candidates, in both stores, from vectors stored as `float32` bytes. At this size (thousands of entries, 1–2 thousand dimensions) a full scan takes milliseconds, so `pgvector` buys nothing yet and would need a superuser to create the extension; it becomes worth it with hundreds of thousands of vectors (library documentation), and the store contract leaves room for it.

## Phases

1. **Contracts**: `access` (teams, path containment, specificity, team grants, path helpers), `core` (team documents, triggers by teams and patterns), `managed-config`.
2. **Everything else moves**: store, settings, jobs, guide, knowledge, server, web. Groups and subgroups are deleted, not shimmed.
3. **Knowledge applicability**: `match`, new `placeLessons`, family suggestions across folders.
4. **Vectors**: `embed`, `embed-openai`, store support, hybrid ranking, semantic duplicates.
5. **Neighbours** (implemented): a similarity graph of repositories, knowledge of close neighbours offered as a lower-priority block, review quality per cited entry. Shipped: `repoNeighbours` (family similarity, own family left out) in `guide`, `selectNeighbourKnowledge` in `knowledge`, the Guide's last and first-cut `neighbours` layer (15% of the budget) for reviews, agents and the chain, limited to entries the repository's own teams read or `shared` ones (plus the person's own reach), and per-entry citation outcomes (`[kb:<id>]` in posted review comments: resolved, dismissed, open) on the Notes table, the note sheet and `GET /api/knowledge/:id/citations`.

Data already stored under groups is converted once outside the code base (group keys to team keys, subgroups to folder patterns); the code keeps no compatibility layer.
