# @holtkeeper/knowledge

A knowledge base of team decisions that agents read and propose and people curate. Entries live in `Store.knowledge` (see [@holtkeeper/store](../../store/docs/README.md)); this package holds the rules around them: validation, classification of agent proposals, deduplication, and picking the entries an agent should read for a task.

## Entries

| Field                    | Meaning                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `title`, `body`          | Short statement and markdown explanation                                                             |
| `kind`                   | `decision`, `convention`, `migration`, `quirk` or `howto`                                            |
| `scope`                  | Which repositories it applies to (`Scope` from `@holtkeeper/access`: everything, groups, repo globs) |
| `topics`                 | Free tags, lowercase: `testing`, `i18n`, ...                                                         |
| `appliesTo`              | Task kinds: `review`, `port`, `propagate`, `tests`, `quality`, `release-risk`, or `*`                |
| `packages`               | `{ ecosystem, name, from?, to? }`; `from`/`to` are semver ranges. Required for migrations            |
| `status`                 | `proposed` → `accepted` / `rejected`; `archived` when no longer true                                 |
| `source`, `author`       | `human` or `agent`, and who created it                                                               |
| `evidence`               | Links `{ label, url }` backing it up                                                                 |
| `supersedes`             | Id of the entry it replaces                                                                          |
| `version`, `history(id)` | `version` grows with every save; the store keeps every previous version with editor and time         |

A migration's `from` and `to` are the ranges it starts from and lands on: a react 18 → 19 note has `from: '>=18 <19'`, `to: '>=19 <20'` and applies to any task touching a react version in either range (`>=18 <20`).

## API

- `validateEntry(value)` → `{ success, data | issues }` and `knowledgeDraftSchema` (zod). Rules: the scope covers something, `appliesTo` is not empty, a `migration` names its packages. Topics are lowercased and deduplicated.
- `classifyProposal(entry, { taskKind, repo, packages })` — pure heuristics filling what a proposal leaves out:
  - packages: task packages the text mentions (whole word, or the last segment of a scoped name), with `compatibleRange` of the task's versions;
  - kind: `migration` for such a package during `propagate`/`port` or upgrade wording; then `quirk`, `howto`, `convention` by wording; `decision` otherwise;
  - topics: keyword families (`testing`, `i18n`, `security`, `performance`, `build`, `dependencies`, `ci`, `release`, `api`, `style`);
  - appliesTo: the proposing task's kind plus kinds implied by kind and topics; `*` for quirks, how-tos and anything not narrowed.
- `selectForTask({ entries, task: { kind, repo, packages?, query? }, budgetTokens })` → `{ selected, omitted, markdown, tokens }`. Keeps accepted entries whose scope covers the repository and whose `appliesTo` holds the task kind or `*`; migrations only when a task package overlaps their ranges; drops entries another match supersedes. Ranks by scope specificity (`scopeSpecificity` of `@holtkeeper/access`: exact repo > glob > group intersection > group > everything), then relevance to the query and task packages, then recency. Adds entries while the rendered block stays within the budget (4 characters per token); oversized entries are skipped, not cut. Each entry is headed `### [kb:<id>] Title` so the agent can cite it.
- `proposeEntry({ store, input, actor, task, now, autoAccept?, duplicateOverlap? })` — creates a `proposed` agent entry (or `accepted` when its kind is in `autoAccept`), scoped to the task's repository unless the input says otherwise. If the proposal repeats a proposed, accepted or rejected entry — same title or body words, or word overlap (Jaccard) ≥ 0.8 — nothing is created: new evidence links are merged into the existing entry and its id comes back as `duplicateOf`. Invalid proposals throw `KnowledgeValidationError`. Writes `knowledge.proposed`, `knowledge.accepted` or `knowledge.evidence-added` activity.
- `knowledgeAccess({ store, now, autoAccept? })` — what agent tools call. `autoAccept` is a list of kinds or a function of the proposing repository returning them (the server resolves the scoped `knowledge.autoAccept` setting this way):
  - `search(query, { repo, taskKind, limit? })` → `{ id, title, kind, body, score }[]`: accepted entries applicable to the repository and task kind, best match first (blank query: all applicable, most specific first). Migrations are not filtered by package here, since the query decides.
  - `propose(input, { actor, repo, taskKind, packages? })` → `{ id, status, duplicateOf? }`.
- Helpers: `matchesTask`, `renderEntry`, `citation`, `packageOverlaps`, `compatibleRange`, `coerceVersion`, `describePackage`, `relevance`, `textOverlap`, `estimateTokens`.

## Server

`/api/knowledge` routes (in `apps/server`) let people list, search, edit, accept, reject, archive and delete entries with `knowledge:read` / `knowledge:write` checked against each entry's scope. Accepting an entry archives the one it supersedes.

## Limitations

- Classification is keyword based and English only; people are expected to correct kind and topics when accepting.
- Version ranges are matched with `Bun.semver`; versions are coerced from loose strings (`^18.2` → `18.2.0`), ranges are taken as written.
- Deduplication compares against every non-archived entry in memory, which is fine for knowledge bases of a few thousand entries.
