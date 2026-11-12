# Notes and Learnings

Part of the web app's Knowledge docs. Both are tabs of the Knowledge page (`/knowledge/notes`, `/knowledge/learnings`) and show the space picked in the spaces sidebar (`?space=`). `KnowledgePage` renders `NotesTable` and `LearningsTable` from `features/knowledge/` with `{ space, families }`, plus `groups` for `NotesTable` (the known config groups, offered in the note scope editor) and `repos` for `LearningsTable` (the `forge:path` keys the space covers, ignored for _All_). The pure logic is in `lib/knowledge.ts` and `lib/learnings.ts`.

## Notes

`NotesTable` reads `GET /api/knowledge` (with `?repo=` in a repository space, where the server keeps entries covering it) and narrows to the space with `notesOfSpace`: a team lists entries naming the group, also inside an intersection; a family lists entries naming one of its members; a repository lists what covers it, marking entries that only reach it through a broader scope as **Inherited** (`isInherited`).

It is one card: a toolbar, a summary strip, the table and a footer.

- **Toolbar.** The status tabs **Live** (proposed and accepted), **Rejected** and **Archived** with counts over the space (`noteFilters`, `matchesFilter`); a text filter matching title, text, topics and the `kb:` id (`filterNotes`); **Kind**, **Topic** (topics from the space's notes, `noteTopics`) and **Task** filters (notes whose task kinds, `appliesTo`, name a picked task or every task); **Group** by status (the default), topic or kind. **New note** is the page header's primary action with `knowledge:write`.
- **Strip.** The space, accepted and proposed counts (the proposed count links _also in Inbox_ to `/inbox?kind=note`), notes inherited from broader scopes and accepted notes shared with other teams (`noteTotals`).
- **Table.** Columns Permalink (`kb:` and the first 8 characters of the id, `kbId`), Note (title with kind, topic, Inherited and Shared tags), Status in words with a dot, Author with avatar and age, and a copy-link button (`noteLink`). Rows sit under heading rows (`noteSections`): proposals first under **Waiting for review**, newest first, then the rest by status (Accepted, Rejected, Archived), by first topic (alphabetically, notes without a topic last) or by kind in `knowledgeKinds` order. In _All_, other teams' notes (by the entry's `owner`) fold into one **Other teams** row under the table.

A row opens `NoteSheet` beside the table: the URL gets `?note=<id>` (the Knowledge route keeps it next to `space`), so a link opens the same note. J and K step through the rows in table order, folded rows last; Escape closes. The header shows the short `kb:` id with a copy button for the full one (agents cite notes as `[kb:<id>]`), the title, the status, kind, scope, Inherited and subject tags, who wrote or proposed it and who edited it last. With `knowledge:write` its quiet actions are **Accept** and **Reject** for a proposal, **Archive** for an accepted note and **Restore** (accept again) for a rejected or archived one; **Edit** and **Delete** sit behind "⋯" (Delete asks first; its history goes too).

Tabs of the sheet:

- **Note** — the text as Markdown and _Where agents use it_: kind, scope, task kinds, topics, packages with ranges, who may read it (`visibilityOptions`), the permalink and **Copy link**. **Edit** turns the tab into `NoteEditor` (title, Markdown text with preview, and under Details kind, scope, task kinds, topics, packages, visibility, subject and evidence links); for a proposal it offers **Save and accept** and **Save as proposal**. Saves send the version they started from, so a concurrent edit answers 409.
- **History** — the current version and every previous one from `GET /api/knowledge/:id` (`noteVersions`), each with who made it, when and which fields changed from the version before it (`changedFields`); **Restore** on an older version puts its content back as a new version, guarded by the current version (`restoreInput`).
- **Evidence** — the note's links (merge requests, threads, docs), opened in a new tab.

**New note** (the header's primary action; `KnowledgePage` keeps the form state and hands it to `NotesTable`) opens the same sheet with the form, the scope prefilled from the space (`settingScopeOfSpace`); saving opens the new note.

## Learnings

`LearningsTable` reads `GET /api/learnings` (with `?repo=` in a repository space) and keeps the candidates of the repositories the space covers (`learningsInSpace`). Each row carries `sourceKind` (`review-reply`, `merged`, `mcp`) and a deterministic `confidence` from 1 to 5 computed by the server from the sources alone.

- **Toolbar.** Source tabs **All**, **Review reply**, **Merged** and **Over MCP** with counts of proposed candidates (`sourceCounts`); **Section** and **Confidence** filters (Low is 1–2, Medium 3, High 4–5: `confidenceLabel`); **Sort** by evidence (replies plus a direct proposal, `evidenceOf`), confidence or newest (`filterLearnings`); **Accept N selected** when the caller may decide some row.
- **Strip.** Candidates waiting for a person (linking _also in Inbox_ to `/inbox?kind=learning`) and where they came from, plus the selection.
- **Table.** Proposed candidates only: a checkbox (only candidates the caller may decide, `selectableIds`), the rule with its repository and, for a direct proposal, who proposed it and why; the Guide section; evidence; source kind with the first merge request linked and `+N` more; confidence as five bars with the level in words (`confidenceAria` for screen readers); **Promote to**, a scope picker over the scopes the caller may edit, starting at the one `suggestedScope` points at (`suggestedScopeOf`); and Accept, Edit (rule and section in place) and Reject. In _All_, candidates of other teams' repositories fold into an **Other teams** row.

**Accept N selected** sends `POST /api/learnings/accept` once per chosen scope with the ids picked for it. The server checks rights per candidate and per target scope, accepts one after another and writes one `learning.accept` audit event per accepted candidate. Afterwards only the failed candidates stay selected (`selectionAfter`), each with the server's reason under its rule, and a toast counts what was accepted.

Keys (outside text fields): J and K move the focused row, X toggles its selection, P accepts the selected rows or else the focused one (into its chosen scope), D rejects them. The footer shows the keys.

Under the table, **Accepted rules live in the Guide** counts accepted rules per section with links to that section of the space's Guide (`acceptedBySection`), and **Rejected** shows rejected candidates on request (they can still be accepted or edited). Reactions on review comments are not here: they are in [Quality › Reviews](reviews.md).
