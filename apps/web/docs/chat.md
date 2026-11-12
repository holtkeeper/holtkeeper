# Chat

Part of the web app's docs ([README](README.md)).

**Chat** (`features/chat`, route `/chat?thread=<id>`, needs `repos:read` somewhere) is the team chat over `/api/chat/threads`, laid out as three columns that fill the viewport: threads, the open thread and its context. Helpers live in `lib/chat.ts`.

## Threads

`ThreadList.tsx` is the left column:

- **Search** filters by title on the server (`useChatThreads(archived, q)`, `GET /api/chat/threads?q=`; the typed text is deferred so the list keeps up while typing).
- The **archive** toggle shows the number of archived threads that match the search (`archivedCount`) and switches the list between open and archived threads.
- **New** opens a dialog for an optional title (blank sends none, `newThreadTitle`, and the server names the thread from its first message), the scope (whole team, one repository or one of the groups the caller may use) and whether Holtkeeper replies to every message.
- The **scope switch** (_My teams | All I can see_ and a group picker, `scopeThreads`): team-wide threads count as _My teams_. On _My teams_ the threads of teams outside the viewer's home groups fold under the list into one collapsed **Other teams** section (`OtherTeams`, with the groups they belong to); a group keeps that group's threads and _All I can see_ everything, neither folds. Without home groups _My teams_ lists only the team-wide threads, and **Choose your teams** (`NoTeamsState`) when there are none.
- Each row shows the title (a quiet `Naming…` while `titlePending` and the thread has a message, `isNaming`; a pending thread without messages shows its `New thread` placeholder muted; the header shows the same and the list and message polls pick up the generated title), the scope, the last activity, a writing indicator, a muted icon and the unread badge (`threadBadge`: none for muted threads).

The rail's Chat icon shows the total unread count (`GET /api/chat/unread`, every 30 s); muted threads never count there.

## The open thread

`ThreadPane.tsx` and `Messages.tsx`:

- Consecutive messages of one author within five minutes share one header (`groupMessages`), with a line per day and a **New** line above the first message that was unread when the thread opened (`firstUnreadId`).
- People show with their avatar and name (their participant label, all the model gets, on hover); Holtkeeper with its avatar and an `AI` tag. Messages that mention the viewer are tinted.
- Bodies are Markdown; commands show as code. A message without a card lists what it refers to as chips (`RefChips` in `Refs.tsx`), read from the refs the server stored with it, never parsed from the body: repositories (to the repository hub), merge requests (`path!iid`, to the hub's Activity), task groups (`Task <short id>`, to Ops › Tasks), runs (`Run <short id>`, to the run page) and knowledge notes (`kb:<short id>`, as the Notes table shows it, to Knowledge › Notes). The server leaves out refs to repositories the viewer may not read.
- Agent replies show a collapsible tool trace (`toolSummary`; opening it loads the transcript from `GET /api/chat/messages/:id/transcript` and lists each call with its input and result, `toolCalls`) and, for viewers with `ai:read` on the thread's scope, their cost (`formatCost`; the server sends no cost to anyone else).
- The header renames the thread inline (any rename of a pending thread is sent, also one to `New thread`, so the generated title never replaces it) and shows its scope, **Auto reply** and **Muted** tags. Its "⋯" menu (`MoreMenu`) holds **Mute thread** / **Unmute thread** (`PATCH { muted }`, the viewer's own), **Export as Markdown** (downloads `GET /api/chat/threads/:id/export`) and **Archive thread** / **Restore thread**.

### Cards

Holtkeeper's answers are cards (`ChatCard`): a tone stripe, title and subtitle, section headings, dividers, Markdown text, fields, steps as a timeline or a row of stages, lists, buttons (danger buttons ask first; they post the command as `/command`) and inline forms whose submit runs `formCommand`.

A task card (`TaskBlock`) shows the plan and one step per repository as the server rewrites it while the group moves on: waiting for approval, queued, the agent at work, a merge request open (linked as `!id`), done, failed with its error, cancelled. Cards without steps list the repositories with their merge requests. Under them sit a status tag, the group's spend cap while it waits and, while it waits, **Approve** and **Reject** (each asks first, then `POST /api/task-groups/:id/approve` or `/reject`: the same permission checks and audit events `task.approve` / `task.reject` as the Inbox, and a 403 shows as a toast) plus **Open in Inbox** (`/inbox?item=task:<groupId>&kind=task`). Then **Task details** (the group on Ops › Tasks) and, once approved, **Cancel task** while something can still stop (`taskCancellable`; asks first, then `POST /api/task-groups/:id/cancel`).

### Composer

`Composer.tsx` takes focus when a thread opens (it is keyed by the thread, so switching threads focuses again), except on touch screens, where that would pop up the keyboard, and when another field already has focus. `@` opens the people who can see the thread (`GET /api/chat/threads/:id/people`) with Holtkeeper first (`mentionAt`, `mentionOptions`, `insertMention`); a leading `/` switches to command mode with matching commands as hints (`matchingCommands`) and the repository or group they run about; in team-wide threads, which refuse commands, it says that commands run in repository and group threads instead and does not send. Arrows and Tab pick, Escape closes the list, Enter sends, Shift+Enter starts a line. The footer says whether Holtkeeper will reply (`asksAgent`, which reads mentions like the server's `parseMentions`).

## Context column

The right column (wide screens) reads `GET /api/chat/threads/:id/context` (`useChatContext`, every 30 s), totals over the whole thread rather than the loaded page:

- **Thread** (its short id in mono beside the heading): scope, kind (`threadKind`), message count, whether the viewer muted it and the groups it belongs to.
- **Context**: the repositories attached to the thread that the viewer may read, each removable, and **Add repo** with the readable repositories not attached yet (`addableRepos`). Changes send the whole list (`PATCH { contextRepos }`); the server keeps the ones the viewer cannot see, and the column only says how many there are. Holtkeeper's replies read the attached repositories only where the person asking may read them.
- **Mentioned**: repositories the messages refer to that are not attached.
- **Agent**: the auto reply switch, whether older messages reach the agent as a summary, and the tool calls summed over every reply.
- **Participants**: avatar, name, messages written and participant label.
- **Cited and linked**: every non-repository ref of the loaded messages once (`threadRefs`).
- **Agent cost**: the thread's total and an **Open AI spend** link to Ops › AI spend, only when the server sends the total (`ai:read` on the thread's scope).

## Live updates

`useChatThread` loads the newest 50 messages once, then polls every 3 s (1.5 s while a reply is being written or a card from the last day shows unfinished steps, `hasLiveCards`: running, pending or waiting steps, or queued and running task steps) with `after=<cursor>&changedSince=<serverTime>`, folding new and changed messages into the cache (`withNewer`); the cursor moves only with message pages, never with a message the viewer posted, so messages others stored in between are not skipped. **Load older messages** puts the page before the first one in front (`withOlder`) and keeps the scroll position. A posted message goes into the cache at once. The view follows new messages while scrolled to the bottom, and the newest message is marked read while the tab is visible, or as soon as it becomes visible. Thread lists poll every 10 s.
