# @holtkeeper/knowledge

A knowledge base of team decisions that agents read and propose and people curate. Entries live in `Store.knowledge` (see [@holtkeeper/store](../../store/docs/README.md)); this package holds the rules around them: validation, classification of agent proposals, deduplication, and picking the entries an agent should read for a task.

## Entries

| Field                    | Meaning                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `title`, `body`          | Short statement and markdown explanation                                                             |
| `kind`                   | `decision`, `convention`, `migration`, `quirk` or `howto`                                            |
| `scope`                  | Which repositories it applies to (`Scope` from `@holtkeeper/access`: everything, groups, repo globs) |
| `topics`                 | Free tags, lowercase: `testing`, `i18n`, ...                                                         |
| `appliesTo`              | Task kinds: `review`, `port`, `propagate`, or `*`                                                    |
| `packages`               | `{ ecosystem, name, from?, to? }`; `from`/`to` are semver ranges. Required for migrations            |
| `visibility`             | `team` (default) or `shared`: other teams read it through the cross-team catalog                     |
| `subject`                | What it is about, a join key: `npm:react`, `Go:example.com/kit`, `tool:node`                         |
| `status`                 | `proposed` → `accepted` / `rejected`; `archived` when no longer true                                 |
| `source`, `author`       | `human` or `agent`, and who created it                                                               |
| `evidence`               | Links `{ label, url }` backing it up                                                                 |
| `supersedes`             | Id of the entry it replaces                                                                          |
| `version`, `history(id)` | `version` grows with every save; the store keeps every previous version with editor and time         |

A migration's `from` and `to` are the ranges it starts from and lands on: a react 18 → 19 note has `from: '>=18 <19'`, `to: '>=19 <20'` and applies to any task touching a react version in either range (`>=18 <20`).

## API

- `sharingDefaults({ kind, packages, subject?, visibility? })` — what an entry gets when its author leaves them out: an entry about exactly one package has that package as `subject` (`packageSubject`: `npm:<name>`, `Go:<module>`), and a decision or convention with a subject is `shared`. Everything else stays `team`. The server applies it to people's new entries too.
- `validateEntry(value)` → `{ success, data | issues }` and `knowledgeDraftSchema` (zod). Rules: the scope covers something, `appliesTo` is not empty, a `migration` names its packages. Topics are lowercased and deduplicated.
- `classifyProposal(entry, { taskKind, repo, packages })` — pure heuristics filling what a proposal leaves out:
  - packages: task packages the text mentions (whole word, or the last segment of a scoped name), with `compatibleRange` of the task's versions;
  - kind: `migration` for such a package during `propagate`/`port` or upgrade wording; then `quirk`, `howto`, `convention` by wording; `decision` otherwise;
  - topics: keyword families (`testing`, `i18n`, `security`, `performance`, `build`, `dependencies`, `ci`, `release`, `api`, `style`);
  - appliesTo: the proposing task's kind plus kinds implied by kind and topics; `*` for quirks, how-tos and anything not narrowed.
- `selectForTask({ entries, task: { kind, repo, packages?, query? }, budgetTokens })` → `{ selected, omitted, markdown, tokens }`. Keeps accepted entries whose scope covers the repository and whose `appliesTo` holds the task kind or `*`; migrations only when a task package overlaps their ranges; drops entries another match supersedes. Ranks by scope specificity (`scopeSpecificity` of `@holtkeeper/access`: exact repo > glob > group intersection or subgroup > group > everything; a subgroup entry such as `{ groups: ['shapes.round'] }` always ranks above one on its parent `shapes`, and a repository in a subgroup is covered by entries on the parent too), then relevance to the query and task packages, then recency. Adds entries while the rendered block stays within the budget (4 characters per token); oversized entries are skipped, not cut. Each entry is headed `### [kb:<id>] Title` so the agent can cite it.
- `proposeEntry({ store, input, actor, task, now, autoAccept?, duplicateOverlap?, notDuplicates?, duplicateScope? })` — creates a `proposed` agent entry (or `accepted` when its kind is in `autoAccept`), scoped to the task's repository unless the input says otherwise. If the proposal repeats a proposed, accepted or rejected entry — same title or body words, or word overlap (Jaccard) ≥ 0.8 — nothing is created: new evidence links are merged into the existing entry and its id comes back as `duplicateOf`. Invalid proposals throw `KnowledgeValidationError`. Unless the input sets them, `sharingDefaults` picks subject and visibility. Audits `knowledge.propose`, `knowledge.accept` or `knowledge.evidence` (actor the agent, `via: 'job'`, target the entry and the task's repository) when the store has an audit log.
- `proposeEntry` also takes `input.supersedes`: the id of the narrower entry the proposal replaces (a repository entry a subgroup-wide one generalises). That entry is left out of the duplicate check, so the generalisation is not swallowed as its duplicate, and the new entry stores it as `supersedes`; every other entry still dedupes. Accepting the new entry archives the superseded one (server). `notDuplicates` leaves more ids out of the check (every narrower entry a promotion generalises), and `duplicateScope(entry)` limits the check to the entries it holds for (starter knowledge: the repository's team and the same library subject), so a lesson is not merged into another team's entry.
- `mergeEvidence({ store, entry, evidence, actor, repo?, now })` → `{ entry, added }` — adds the links whose URL the entry does not have yet, text and status untouched; audited as `knowledge.evidence`. `proposeEntry` uses it for duplicates.
- `placeLessons(input)` — the scope agreement of starter knowledge, see [below](#scope-agreement).
- `bootstrapMarker(repo)` — `knowledge:bootstrap:<forge>:<path>`, the `Store.kv` key that marks a repository whose starter knowledge was built (written by [@holtkeeper/knowledge-bootstrap](../../knowledge-bootstrap/docs/README.md)).
- Scope helpers: `describeScope(scope)` (`group shapes`, `subgroup shapes.round`, `repo work:acme/kit`), `exactRepos`, `scopeNamesRepo(scope, repo)` (the scope names the repository by exact path, `forge:path` or bare), `entryGroups(entry, groupsOf, forge)` (every group an entry reaches, through its groups or the repositories it names) and `entriesInRoots(entries, repo, groupsOf)` (proposed and accepted entries sharing a root group with the repository, `all` scopes left out).
- `knowledgeAccess({ store, now, autoAccept? })` — what agent tools call. `autoAccept` is a list of kinds or a function of the proposing repository returning them (the server resolves the scoped `knowledge.autoAccept` setting this way):
  - `search(query, { repo, taskKind, limit? })` → `{ id, title, kind, body, score }[]`: accepted entries applicable to the repository and task kind, best match first (blank query: all applicable, most specific first). Migrations are not filtered by package here, since the query decides.
  - `propose(input, { actor, repo, taskKind, packages? })` → `{ id, status, duplicateOf? }`.
- Helpers: `matchesTask`, `renderEntry`, `citation`, `packageOverlaps`, `compatibleRange`, `coerceVersion`, `describePackage`, `relevance`, `textOverlap`, `estimateTokens`.

## Scope agreement

`placeLessons({ repo, lessons, entries, groupsOf, libraryHome?, promote })` decides, for each lesson an agent learned about one repository, at which level the entry goes. It is pure and deterministic; the caller writes each decision through `proposeEntry` (`create`) or `mergeEvidence` (`covered`). Lessons (`LessonDraft`) carry `level` (`repo` code, `process` team process, `library` how to use the library in `library`), `repoSpecific`, `related` (ids of existing entries the lesson repeats) and an optional `general` wording true for every repository involved.

1. **Library.** A `library` lesson gets the library as `subject` (`Go:<module>`, `npm:<name>`), visibility `shared` and the package. When `libraryHome(subject)` is another fleet repository, the entry is scoped to that repository (level `library`) and placement stops.
2. **Matches.** Candidates are proposed and accepted entries that cover the repository or lie in one of its root groups (through their groups or the groups of the repositories they name), never `all` scopes. An entry another candidate `supersedes` is no candidate itself: its text and id count for the entry that replaces it, so later siblings find a pending promotion instead of proposing a second one. A lesson matches an entry it names in `related`, or one whose title overlaps by `TITLE_MATCH` (0.5), or whose title and text overlap by `TEXT_MATCH` (0.35) — Jaccard over significant words, `general` wording counted too. Matches rank linked first, then overlap, then narrower scope, then newest, then id.
3. **Covered.** When any match already covers the repository (not only the best one) the lesson is `covered`: its evidence goes into the best such entry and nothing new is written. This also holds for `repoSpecific` lessons and with `promote: false`, so a forced rerun does not repeat the repository's own entries.
4. **Repository by default.** Otherwise the scope is the repository (`forge:path`). With `promote: false`, a `repoSpecific` lesson or no match it stays there.
5. **Level.** The root group holding the best match decides (ties: more matches, then name). The entry goes to the subgroup the repository shares with every match in that root (`subgroup`: siblings in the same subgroup have it), and otherwise to the root group (`group`): the matches span two or more subgroups or lie outside the repository's. Team `process` always goes to the root group. A repository in several subgroups (overlapping includes) only counts the ones its matches share.
6. **Promotion.** A promoted entry uses the lesson's `general` wording when given, carries the lesson's evidence and that of every match narrower than the target (a repository entry inside it, or a subgroup entry under a group target), lists those in `generalises` and supersedes the best of them. `why` names the reason and the matches (`a sibling in shapes.round has it: matches kb:1a2b3c4d (repo work:acme/widget-api, overlap 0.62); supersedes kb:1a2b3c4d`).
7. **Rejected promotions.** `entries` may hold rejected entries: one scoped to the target that supersedes a generalised match, or that matches the lesson, means people refused this promotion, and the lesson stays at the repository (`a promotion to shapes.round was rejected (kb:…); kept at the repository`).

Promotions are proposals: nothing placed this way should be auto-accepted, and the starter knowledge analyzer passes no `autoAccept`.

Helpers: `entriesInRoots(entries, repo, groupsOf)`, `reachesRepoRoots(entry, repo, groupsOf)`, `entryGroups`, `exactRepos`, `scopeNamesRepo`, `describeScope`, `bootstrapMarker`.

## Server

`/api/knowledge` routes (in `apps/server`) let people list, search, edit, accept, reject, archive and delete entries with `knowledge:read` / `knowledge:write` checked against each entry's scope. Accepting an entry archives the one it supersedes. The MCP endpoint offers `search_knowledge`, `get_knowledge` and `propose_knowledge` to external agents under the same permissions; their proposals always wait for review.

## Limitations

- Classification is keyword based and English only; people are expected to correct kind and topics when accepting.
- Version ranges are matched with `Bun.semver`; versions are coerced from loose strings (`^18.2` → `18.2.0`), ranges are taken as written.
- Deduplication compares against every non-archived entry in memory, which is fine for knowledge bases of a few thousand entries.
