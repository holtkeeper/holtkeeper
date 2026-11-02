# @holtkeeper/chat

One conversation model for every place people talk to Holtkeeper: merge request comments today, Slack and the web panel next. Commands are written once and answered with surface-independent cards; each surface renders them as well as it can.

```
surface (MR notes, Slack, web) ──ChatMessage──▶ router ──▶ command.run(context)
          ▲                                                    │
          └──────────── render(Card) ◀── reply / LiveMessage ◀─┘
```

## Cards

`Card` is plain JSON (`title?`, `subtitle?` — one line under the title, `tone?`, `url?`, `blocks`), so it can be stored and sent to the panel as it is. Blocks:

| Block     | Shows                                                                                                                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`    | Markdown-ish text: `**bold**`, `` `code` ``, `[label](url)`                                                                                                                                                                                                             |
| `fields`  | Label/value pairs                                                                                                                                                                                                                                                       |
| `heading` | Starts a part of the card: a short label, a `detail` (counts) and an optional tone                                                                                                                                                                                      |
| `divider` | A line between parts                                                                                                                                                                                                                                                    |
| `steps`   | Steps with a `StepStatus` (`pending`, `waiting`, `active` — where things stand without work running, `running`, `done`, `failed`, `skipped`), detail and a link with its `urlLabel` (default `Open`); `layout: 'flow'` shows short stages in a row, like a progress bar |
| `list`    | Items with an optional link and tone                                                                                                                                                                                                                                    |
| `actions` | Buttons; each is a full command line (`release deploy prod tag=v1.2.0 --yes`)                                                                                                                                                                                           |
| `form`    | Fields (`text`, `select` with `multiple`, `toggle`) and the command a submit runs                                                                                                                                                                                       |
| `context` | Small print                                                                                                                                                                                                                                                             |

Buttons and forms are command lines on purpose: a surface with buttons sends the line when clicked, one without shows the line to reply with. Whoever clicks is authorized again when the command runs, so a button carries no authority. `formCommand(form, values)` builds the line a submitted form runs (`name=value`, quoted when needed, multiple values joined with commas).

`textCard(title, text, tone?)` is a card with one text block; an empty title leaves the heading out.

## Commands

```ts
defineCommand({
  name: 'release',
  summary: 'Shows where a repository is in its release flow and runs its steps.',
  usage: '[step] [environment]',
  positional: ['step', 'environment'],
  options: z.object({ step: z.string().default('status'), environment: z.string().optional() }),
  async run({ options, message, reply, require }) {
    const principal = await require('releases:run', message.repo)
    const live = await reply({ title: 'Deploying', blocks: [] })
    await live.update({ title: 'Deployed', tone: 'good', blocks: [] })
  },
})
```

Arguments become options before `options` validates them: `key=value` by name, `--flag` as `true`, the rest onto `positional` in order, the last name taking the rest as a list (`commandOptions`). Double quotes keep spaces (`splitWords`).

`ChatCommandContext` gives the parsed `options`, the `line`, the `message`, the router's `prefix`, `reply(card)` returning a `LiveMessage` and `require(action, repo?)`, which returns the actor's principal or throws `ChatDeniedError`.

## Router

`createChatRouter({ commands, authorize, prefix = 'holtkeeper', onError })` → `ChatRouter`:

- `parse(text, bare?)` — the `/holtkeeper <name> [args]` of a message, from its first line that has one (`parseCommandLine`); `bare` also takes a message that starts with the name (a direct message, a button).
- `handle(message, surface, line?)` — runs the command and answers on the surface. Outcomes: `ignored` (no command, no answer), `done`, `unknown` (answered with the help), `invalid` (the validation errors and the usage), `denied` (what to do about it: link the account, verify it, or that the action is not allowed), `failed` (a `ChatUserError` is shown as it is, any other error as a generic message, passed to `onError`). It never rejects because of a command.

A `help` command listing the commands that are not `hidden` is added unless one is given.

`authorize(actor, action, repo?)` answers `{ allowed: true, principal }` or `{ allowed: false, reason }` with the reasons of `@holtkeeper/identities` (`not-linked`, `unverified`, `no-principal`, `forbidden`).

## Messages and surfaces

```ts
interface ChatMessage {
  surface: string // the surface that answers
  thread: ChatThread // plain JSON, the surface's own address
  actor: ChatActor // { provider: 'gitlab:work', externalId: '42', username? }
  text: string
  repo?: RepoRef
  mergeRequest?: number
  headSha?: string
}

interface ChatSurface {
  readonly id: string
  post(thread, card): Promise<PostedMessage>
  update?(message, card): Promise<void>
}
```

`actor.externalId` is the stable id on the surface (numeric forge user id, Slack member id), never a username. `liveMessage(surface, posted)` updates in place when the surface can, and posts a new message otherwise.

### Merge request notes

`mergeRequestSurface({ forgeOf, marker, id = 'merge-requests', prefix? })` posts cards as markdown notes through `GitForge`. `mergeRequestThread(repo, iid, discussionId?)` addresses the merge request, or one of its threads. With `postMergeRequestNote` a card is a standalone note (not a resolvable thread, so it never blocks merging) or a reply in the thread, and `updateMergeRequestNote` edits it in place; forges without them get `commentOnMergeRequest` / `replyToDiscussion` and a new note per update. Every note ends with `<!-- <marker> -->`.

`renderMarkdown(card, { prefix })` renders a card as GitLab-flavored markdown: a `####` heading with a tone icon, fields and lists as lists, steps with status icons, actions as the commands to reply with, forms as a command template and their fields, the card link last. `muteMentions` breaks `@name` mentions in text with a zero-width space, so cards never notify people by accident.
