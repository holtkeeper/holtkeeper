# Slack review status

Holtkeeper's Slack app watches the channels it is invited to. When a message there links a merge request of a connected repository, the app puts one emoji on the message that shows the review status of that merge request, and keeps it current as reviews run. A message that links several such merge requests also gets one [status reply](#status-reply) in its thread. Apart from that reply the app only posts [release announcements](#release-announcements), where `releases.announce` asks for them.

| Status    | Default emoji    | Fallback                | When                                                      |
| --------- | ---------------- | ----------------------- | --------------------------------------------------------- |
| reviewing | `:hk-reviewing:` | `:eyes:`                | a review of the merge request is queued or running        |
| clean     | `:hk-clean:`     | `:large_green_circle:`  | the latest review says looks good and posted no findings  |
| minor     | `:hk-minor:`     | `:large_orange_circle:` | looks good, with posted minor or info findings            |
| changes   | `:hk-changes:`   | `:red_circle:`          | needs changes, or any posted major or critical finding    |
| skipped   | `:hk-skipped:`   | `:white_circle:`        | the review was skipped (diff too large, nothing in scope) |

The defaults are Holtkeeper's own custom emoji; a workspace without them shows the standard fallbacks (see [Emoji](#emoji)).

A message that links several merge requests shows the worst status among them (changes, then reviewing, minor, skipped, clean). A merge request with neither a queued review nor a stored one gets no emoji until its first review is queued; a link posted after a push but before its review is queued shows the previous verdict until then. The status follows the newest review run, so an incremental review that finds nothing new shows clean even when earlier findings are still open.

## Status reply

When one message links two or more merge requests the app follows (the same gates as the emoji, below), the app posts one reply in the message's thread with a line per merge request, ordered by repository and number: the status emoji (the same, overridable emoji as the reaction), the status name in English (Reviewing, Clean, Minor findings, Needs changes, Not reviewed; a merge request with no review yet reads Not reviewed without an emoji) and a link titled `<repository's last path segment>!<iid> <title>`, e.g. `widget!7 Add widget`. A message with a single followed merge request gets no reply.

- Whenever a status changes, the same reply is edited with `chat.update`; the app never posts a second reply while the first exists. An edit Slack answers with `message_not_found` (someone deleted the reply) posts a new reply, which is then the one edited. Other failures leave the stored text unchanged, so the next status change retries the edit.
- When a gate closes for some of the merge requests, the reply is edited to list those left, even when only one remains. When it closes for the last one, the reply is left unchanged (it still shows the last known statuses); it is never deleted.
- Titles come from the newest stored review of the merge request; otherwise the forge is asked once and the title is kept with the message's row. When the forge cannot give a title (an error, an empty title or no lookup), the line goes without one and the process does not ask again. Labels and links use the repository path in its own case, kept on the row. Labels are escaped for mrkdwn, so a title cannot mention people or break the link.
- The reply and the reaction are updated together under the message's lock, so concurrent status changes leave one reply that matches the emoji.
- Without `chat:write` (`missing_scope`, `not_allowed_token_type`) the app logs that once per process and keeps setting reactions; the reply follows the next status change once the scope is added.

## Set up the Slack app

Slack checks the events request URL as soon as it is saved, and the endpoint only answers once the signing secret is stored in Holtkeeper. So the app is created without event subscriptions first, and they are turned on after the credential is saved.

1. Create an app at <https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick the workspace and paste the manifest below.
2. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`, under **OAuth & Permissions**) and the **Signing Secret** (under **Basic Information › App Credentials**).
3. In Holtkeeper, **Settings › Integrations › Slack**: paste both and save. They are sealed with the server's vault key and never shown again. The section shows the request URL to copy.
4. In the Slack app, **Event Subscriptions**: turn them on, paste the request URL (`https://<host>/api/slack/events`; Slack verifies it at once), add the bot events `message.channels` and `message.groups`, save, and reinstall the app when Slack asks. Instead of the form, the `event_subscriptions` block below can be added to the app's manifest.
5. Invite the app to each channel it should watch: `/invite @Holtkeeper`.
6. Bind the channels to repositories with the `slack.reviews` setting (below).

```yaml
display_information:
  name: Holtkeeper
  description: Review status of merge requests linked in channels, release announcements
features:
  bot_user:
    display_name: Holtkeeper
    always_online: false
oauth_config:
  scopes:
    bot:
      - channels:history
      - groups:history
      - reactions:write
      - chat:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Step 4 as manifest, under `settings`:

```yaml
event_subscriptions:
  request_url: https://<host>/api/slack/events
  bot_events:
    - message.channels
    - message.groups
```

Holtkeeper calls `https://slack.com/api` from the web and worker pods (a review that ends on a worker updates the emoji from there). Where the chart's NetworkPolicy or egress proxy limits outbound traffic, allow `slack.com` for both roles.

`channels:history` and `groups:history` deliver messages of public and private channels the app is in; `reactions:write` sets the emoji. `chat:write` posts and edits [status replies](#status-reply) and [release announcements](#release-announcements); an app installed without it keeps the emoji working, and adding the scope later needs a reinstall (**OAuth & Permissions › Scopes**, then **Reinstall to Workspace**; the bot token stays the same).

## Bind channels

`slack.reviews` (**Settings › Integrations**, scoped like other settings) is `{ channels: string[] }`: Slack channel ids such as `C0123ABCD` (private channels may start with `G`). Copy an id from the channel's details: click the channel name, the id is at the bottom of **About**. Names (`#widgets`) are not accepted.

The most specific entry wins as a whole: an entry for everything binds the default channels, a group or repository entry replaces them for its repositories, and an entry with `channels: []` keeps a group quiet. A message about a merge request of repository R in channel X is handled only when X is among the channels resolved for R, so different groups can share or separate channels.

Nothing happens (no emoji, no reply, nothing stored) when:

- the link's host is not a configured forge, or the repository is in no config group;
- **Merge request reviews** (`mergeRequests.comments`) is off for the repository;
- the channel is not bound to the repository;
- no Slack credential is stored.

When reviews are turned off or the channel is unbound after a message got its emoji, the emoji is removed and the message forgotten at the merge request's next review change (a review queued, canceled or finished); its status reply then lists the merge requests left, and stays unchanged once none is left.

## Emoji

The defaults are Holtkeeper's custom emoji set, kept in [holtkeeper/.github `slack/emoji`](https://github.com/holtkeeper/.github/tree/main/slack/emoji). To use them, a workspace admin uploads each image under **Customize workspace › Emoji › Add custom emoji** with its file name as the emoji name (`hk-reviewing`, `hk-clean`, `hk-minor`, `hk-changes`, `hk-skipped`). No extra scope is needed to find out whether they are there:

- A status without an override first tries its custom emoji. When `reactions.add` answers `invalid_name` (the workspace lacks it), the app adds the standard fallback instead and remembers that the emoji is missing, per process and in `store.kv` under `chat:slack:emoji:<workspace>:<name>` for 6 hours, so every pod goes straight to the fallback until then and a set uploaded later is picked up after that. A custom emoji that was added is remembered as present the same way. `<workspace>` is a hash of the bot token, so a new credential starts over.
- The emoji recorded for a message is the one actually added, so the next swap removes that one; a remove Slack answers with `invalid_name` or `no_reaction` counts as done. A message that already shows the fallback of its status keeps it while the custom emoji is not known present, so an expired entry causes no swap; such a message gets the custom emoji at its next status change.
- Status reply lines use the same emoji: the custom one where the workspace is known to have it (or, for a status not tried yet, when another emoji of the set is known present), the fallback otherwise.

The credential also carries optional overrides per status (Slack emoji names without colons, custom workspace emoji included; `:name:` is accepted and stored without colons). Overrides are used as given, with no fallback: one the workspace lacks shows nothing and is logged once per process with its name. Edit them under the tokens in **Settings › Integrations › Slack** (`PUT /api/slack/emoji`); blank fields use the defaults, shown as placeholders with their fallbacks. A changed emoji shows on a message and in its status reply the next time its status is set.

## How it works

- **Events** (`routes/slack-events.ts`). `POST /api/slack/events` refuses requests without `X-Slack-Signature` or with a timestamp more than five minutes away (401) before reading the body, and bodies over 1 MB (413). It then checks the signature (`v0` HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the signing secret, constant-time compare; 404 while no credential is stored), answers `url_verification` with its challenge and acknowledges every event at once; the work runs in the background. A message event that links a merge request is handled once per `event_id` across processes sharing the store (a one-hour `kv` lease), so Slack's retries are acknowledged and dropped; messages without links take no lease. Handled: plain messages, thread replies, thread broadcasts and file shares in public and private channels; edits (`message_changed`) handle only the links the edit added; a deleted message (`message_deleted`) is forgotten. Bot messages, direct messages and other subtypes are ignored. Deliveries are not audited.
- **Links** (`slack/links.ts`). URLs in the text (Slack's `<url>` and `<url|label>` forms, `&amp;` unescaped, and bare URLs) that start with a configured forge's `url` and have a GitLab merge request path (`<project>/-/merge_requests/<iid>`) name the repository and merge request. Paths are compared without case: a link is matched to the spelling of a repository that has a stored review, and rows are keyed by the lowercased `forge:path`.
- **Status** (`slack/status.ts`, `slack/service.ts`). A queued or running review job of the merge request means reviewing; otherwise the newest stored review run (thread replies left out) decides. `slackMessages` (see [@holtkeeper/store](../../../packages/store/docs/README.md#slack-messages)) keeps one row per message and merge request with the status, the emoji on the message and the cached title, and one row per status reply with its `ts` and last text; link rows older than 30 days are pruned when a message is stored, and a status reply row goes once it is that old and its message has no links left, so a message edited to add links later keeps its one reply. Updates of one message run one at a time, across processes too (a `kv` lease per message), so concurrent review changes and links never leave two status emoji or two status replies.
- **Review hooks** (`mr-status.ts`). `noteReviewJob` tells `deps.mergeRequestStatus` (a `MergeRequestStatusSink`) when a review job is queued (webhooks, polling, commands, manual runs), canceled (by hand, or by the worker: superseded, or reviews turned off before it ran) or finished (succeeded, failed for good, blocked). The server builds one Slack review status and passes it as both `mergeRequestStatus` and `slackReviews`, which the events route uses. The sink rereads the state, so the review pipeline knows nothing about Slack. A new push queues a review, which swaps the verdict for reviewing; the stored review then sets the new verdict.
- **Reactions** (`slack/client.ts`). `reactions.add` and `reactions.remove` over `fetch` with the bot token; exactly one status emoji is on a message: the previous one is removed before the new one is added (`no_reaction`, a remove's `invalid_name` and `already_reacted` count as success; an add's `invalid_name` is not logged, the service falls back as in [Emoji](#emoji)). When the remove fails, nothing is added and the old emoji stays recorded, so the next update retries the swap; `message_not_found`, `channel_not_found` and `not_in_channel` forget the message. A 429 waits for `Retry-After` (up to 30 s, three times), and the waits of one update share a 30 s budget. Failures are logged and never reach the review.

## Release announcements

With `releases.announce` (section Releases, edited under **Settings › Integrations**, scoped like other settings, the most specific entry wins as a whole) a repository's new versions get a message in the listed channels, whatever creates the tags: Holtkeeper's version step, changesets, release-please or a CI job, in every flow mode. Invite the app to those channels; it posts with `chat:write`.

| Field                | Default              | What it does                                                                                                                   |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `channels`           | none                 | Slack channel ids; without any nothing is announced or recorded                                                                |
| `tags`               | flow tags + packages | Glob patterns of tag names (`@acme/*@*`); by default tags that follow `releases` › `version.tagFormat` and package tags        |
| `groupWindowMinutes` | 10                   | Tags found within this many minutes of the first one make one message                                                          |
| `notes`              | on                   | AI notes: overview, highlights, breaking changes with migration hints                                                          |
| `tasks`              | on                   | Tracker tasks named by the commits, with links from `releases` › `changelog.ticketUrl`                                         |
| `impact`             | on                   | "Will break on upgrade": connected repositories whose code uses what the new version removed                                   |
| `language`           | review language      | Language of the AI prose; default `analyzers.review` › `language` of the repository, else English; code and terms stay English |

**Finding new tags.** Tag events (GitLab tag push webhooks and polled tags, through the event dispatcher) and, as a fallback, the freshness sweep (every five minutes; each covered repository's newest 100 tags at most every 15 minutes) feed `releaseAnnouncerFor(deps)`. The first look at a repository with channels records a baseline: every tag listed then counts as seen, so history is never announced (a tag whose push delivered that first look is the exception: it is new). Removing the channels forgets the baseline, so turning them on again starts over. Tags that `tags` (or the default) does not cover are ignored, but every polled tag is marked seen, so widening `tags` or `version.tagFormat` later does not announce older tags. Events and polls carry the tagged commit's sha (GitLab's `checkout_sha` for annotated tags), so both find the same `api-surface` jobs and records. When the newest 100 tags hold no earlier version of a package, the newest 1000 are searched once. Package tags (`@acme/widgets@1.2.3`, `widgets-v1.2.3`, `path/v1.2.3`) name the package and its version; the previous version is the highest lower version of the same package (of the repository for plain tags), release candidates only when the new tag is one or `version.prerelease` is on.

**Batches.** New tags of a repository join the open batch until its window (`groupWindowMinutes` from the first tag, fixed when the batch opens) closes, else start a new one; a batch goes out once its window closed. The state is one `store.kv` document per repository (`release:announce:<forge>:<path>`: baseline, seen tag names, batches), every change a `compareAndSet` that rereads on conflict, so with several processes a tag joins one batch and a batch is claimed (`collecting` → `posting`) and posted by one process only. A batch still `posting` 15 minutes after its claim belonged to a process that died: it is given up with a log line rather than risk a second post. When Slack accepts the message in no channel, or no Slack credential is stored, the batch goes back to `collecting` and is tried again after 1, 2, 4, … (at most 60) minutes, for a day after it opened; errors retrying cannot fix (`channel_not_found`, `is_archived`, `invalid_blocks`, …) give up at once. A post accepted in some channels counts as posted. `release:announce:repos` lists repositories with a baseline (changed with `compareAndSet` too).

**Ordering.** For each new tag, and the version before it, an `api-surface` job is queued (trigger `tag`, ref `releaseTarget`: the commit for package tags, the tag otherwise) unless a record with that ref exists or such a job is queued or running already — only by the process whose `compareAndSet` added the tag, and after the dispatcher queued `jobs.onTag` — and the batch remembers the jobs and which tags they cover. Once the window closed it is posted when every tag and previous version has its `api-surface` record (checked by ref, so impact always compares the exact two versions, and checked again after the claim); otherwise it waits while its jobs run. Records are looked up through a per-process index of `api-surface` refs that only reads records created since its last look. When the jobs ended without records (failed) or 30 minutes after the batch opened, it is posted without impact and with the line _Compatibility analysis is still running_; once the records land (a finished `api-surface` job or the sweep checks), the same messages are rewritten with `chat.update`, for at most a day, then the line becomes _Compatibility analysis is unavailable_. An update Slack refuses keeps the impact pending and is tried again on the next pass. With `impact` off, or where `api-surface` is not set up or turned off for the repository, nothing is waited for.

**Content.** A header with the package (or the repository path for plain tags) and version, the previous version and a compare link; with several tags in a batch, one section per package under _New versions in <repository>_. Then the AI notes, _Breaking changes_ (from the notes, else breaking commits — `!` or `BREAKING CHANGE:` — and the API diff: removed exports, members a declaration lost), _Changes_ grouped by changelog section with merge request or commit links, _Tasks_, and _Will break on upgrade_: per connected repository using the package (newest `usages` record, the releasing repository and repositories already on the new version left out) its current version, the number of broken uses, the exports they go through and up to three file links. It reads _No connected repository is affected_ when the diff breaks something nobody uses, _No usage data from connected repositories yet_ when no other repository has a `usages` record, and is left out when nothing breaks. The block follows `access.crossTeam`: under `off` only repositories sharing a config group with the releasing repository are named and the others counted (_N repositories of other teams_); under `metadata` other teams' repositories are named without file links; under `snippets` (default) everything shows. A failure computing one package's impact leaves that package without the block. For monorepo package tags the commits (and their tasks) are narrowed to the package by conventional-commit scope (`widgets` or `@acme/widgets`) when any commit in the range is scoped to it; unscoped commits stay. AI prose is converted with `toMrkdwn` of [@holtkeeper/notify](../../../packages/notify/docs/README.md). Sections stay under 3000 characters and the message under 50 blocks: longer lists end with _…and N more_, linking to the repository's release timeline in Holtkeeper when `server.publicUrl` is set.

**Notes and budget.** One call per batch (`writeAnnouncementNotes` of [@holtkeeper/release](../../../packages/release/docs/README.md#announcements), task kind `release-notes`, tier `fast`) through `automaticAgentFor(repo, 'agent:release-announce')`, so it counts as automatic work and leaves the budget reserve alone. When the budget blocks it or the agent fails, the message goes out without notes, and the call is not repeated for that batch. Notes are kept with the batch and reused when the impact update rewrites the message; breaking changes the API diff finds and the notes do not name are added below the notes' own.

**Posting** (`slack/client.ts`). `SlackPoster` (`chat.postMessage`, optionally in a thread, and `chat.update`, link previews off) posts announcements and status replies; it is separate from the reactions-only `SlackApi`, with the same 429 handling; errors are logged and never reach jobs.

Tests: `src/slack/*.test.ts` (signature, links, statuses and the status list text, client and its wait budget, the custom emoji catalog) and `test/slack-reviews.test.ts` (endpoint, header and size checks, retries, gates and gates closing later, late links, pushes, cancels, overrides, reaction swaps, failed removes, concurrent updates, deleted messages, path spelling; status replies: posting, edits, single links, a deleted reply, a missing scope, forge titles, a title the forge cannot give, path spelling in labels, a closing gate, concurrent changes; custom emoji: the set when present, the fallback when missing and remembered across processes, swaps removing the emoji added, overrides kept and logged, reply lines), `test/slack-tokens.test.ts` (credential and emoji routes), `src/slack/announcement.test.ts` (blocks, impact variants, Slack limits) and `test/release-announce.test.ts` (baseline, window, two processes, ordering, timeout and update, impact variants, budget, language, tag filter, monorepo batches, refused posts and updates, missing credential, dead posting process, dispatch without a background list, cross-team reach, notes plus API breaking changes).
