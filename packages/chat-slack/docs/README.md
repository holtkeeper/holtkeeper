# @holtkeeper/chat-slack

Slack as a surface of [@holtkeeper/chat](../../chat/docs/README.md): the `/holtkeeper` slash command, mentions, direct messages, buttons and form modals all reach the same commands as merge request comments, and answers are Block Kit messages that commands can update in place.

It talks to the Slack Web API with `fetch` and keeps no state; the server checks signatures, answers Slack within its three seconds and runs commands afterwards.

## Setting up the Slack app

The server's **Slack** page in the panel walks through it and builds everything from the server's address: `slackManifest({ baseUrl, name? })` is the app manifest (a bot user, the `/holtkeeper` slash command, `app_mention` and `message.im` events, interactivity, all pointing at `slackRequestUrls(baseUrl)`), and `slackCreateAppUrl(manifest)` opens Slack's "create an app" dialog with it filled in. `slackScopes` lists the bot scopes with what each is for: `chat:write`, `chat:write.public` (digests to public channels without an invite), `commands`, `app_mentions:read`, `im:history`, `channels:read` and `groups:read` (listing channels to connect).

After installing the app, its **Bot User OAuth Token** and **Signing Secret** are pasted in the panel (or set as `chat.slack` in the config file, which then wins). People link their Slack account by sending the bot `link` in a direct message.

## Requests

All three take the raw body; check it first with `verifySlackRequest`.

- `parseSlashCommand(body: URLSearchParams)` — the command text (empty means `help`), the channel and `response_url`.
- `parseEvent(json)` — `url_verification` gives `{ kind: 'challenge' }`; `app_mention` (the mention dropped, answered in the thread of the mention) and `message` in direct messages give a command. Messages of bots and subtypes (edits, joins) are ignored.
- `parseInteraction(body: URLSearchParams)` — a command button (`action_id` starting with `COMMAND_ACTION`) runs its value in the thread of its message; a form button (`FORM_ACTION`) gives `{ kind: 'open-form', triggerId, form, thread }`, to open with `formModal(form, thread)` at once; a submitted form modal runs `formCommand` of its values in the thread it came from. Link buttons are ignored.

Each answers a `SlackInbound`: `challenge`, `command` (`teamId`, `userId`, `text`, `thread`), `open-form` or `ignored` with a reason.

`verifySlackRequest({ signingSecret, timestamp, signature, body, now?, toleranceSeconds = 300 })` checks `X-Slack-Signature` (`v0=` HMAC-SHA256 of `v0:<timestamp>:<body>`) in constant time and refuses timestamps further than the tolerance from `now`. `signSlackRequest` signs a body the same way, for tests.

## Messages

`renderSlackMessage(card, { prefix })` → `{ text, blocks }`:

| Card part | Block Kit                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| title     | `header` with the tone icon                                                                                |
| `text`    | `section` in mrkdwn (`toMrkdwn` of `@holtkeeper/notify`: converted and escaped, so no mentions)            |
| `fields`  | `section` fields, ten per section, twenty at most                                                          |
| `steps`   | one `section`, a line per step with its status icon and link                                               |
| `list`    | one `section` with bullets                                                                                 |
| `actions` | `actions` with a button per command (its line is the `value`); `danger` buttons ask for confirmation first |
| `form`    | a button that opens the form as a modal (the form is its `value`); too large forms show the command        |
| `context` | `context`                                                                                                  |
| `url`     | a link button **Open in Holtkeeper**                                                                       |

At most 50 blocks; `text` (the title, else the first text) is the notification fallback.

`formView(form, metadata)` builds the modal: `static_select` or `multi_static_select` for selects (100 options), `plain_text_input` for text, `checkboxes` with one box for toggles; `metadata` (3000 characters at most) comes back on submit. `formValues(form, state.values)` reads the submission back by field name.

## Surface and client

`slackSurface({ client, id = 'slack', prefix? })` posts cards with `chat.postMessage` in the thread's channel (and thread), returning `<channel>/<ts>` as the message id, and updates them with `chat.update`. When the bot may not post there (`not_in_channel`, `channel_not_found`, `is_archived`) and the thread has a `response_url`, the card goes privately through it instead; such answers cannot be updated.

`slackClient({ token, fetch?, baseUrl? })` — `sendMessage` (`chat.postMessage`), `updateMessage`, `openView`, `respond` (only to `https://hooks.slack.com/`), `identity()` (`auth.test`: team, bot and their ids) and `channels()` (`conversations.list`: public channels and private ones the bot is in, by name, up to 20 pages). `token` is a secret or a function called on every request, so a token changed elsewhere applies at once. Failures are `SlackApiError` with Slack's `code` (`not_in_channel`, `expired_trigger_id`, `http_429`, …); the token is resolved per call and never part of an error.
