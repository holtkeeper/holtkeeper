# @holtkeeper/chat-slack

Block Kit rendering for [@holtkeeper/chat](../../chat/docs/README.md) cards and forms. It only builds payloads: nothing here talks to Slack, receives its requests or posts messages. The chat integration was removed for now. The server's Slack app only marks messages that link merge requests with a review status emoji, keeps a plain-text status reply under messages linking several, and posts release announcements ([Slack review status](../../../apps/server/docs/slack.md)), so it does not use this library; it stays for when a chat integration comes back.

Buttons carry their command line in `value` with `action_id` `COMMAND_ACTION:<index>`; form buttons use `FORM_ACTION` and carry the form as JSON; link buttons use `LINK_ACTION`.

## Messages

`renderSlackMessage(card, { prefix })` → `{ text, blocks }`:

| Card part | Block Kit                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| title     | `header` with the tone icon, the subtitle as a `context` under it                                                                                                                        |
| `text`    | `section` in mrkdwn (`toMrkdwn` of `@holtkeeper/notify`: converted and escaped, so no mentions)                                                                                          |
| `fields`  | `section` fields, ten per section, twenty at most                                                                                                                                        |
| `heading` | `section` with the tone icon, the label in bold and the detail                                                                                                                           |
| `divider` | `divider`                                                                                                                                                                                |
| `steps`   | up to ten steps with links: a `section` each with a button to the link (`urlLabel`); otherwise one `section` with a line per step; `flow`: one `context` line of stages joined by arrows |
| `list`    | one `section` with bullets                                                                                                                                                               |
| `actions` | `actions` with a button per command (its line is the `value`); `danger` buttons ask for confirmation first                                                                               |
| `form`    | a button that opens the form as a modal (the form is its `value`); too large forms show the command                                                                                      |
| `context` | `context`                                                                                                                                                                                |
| `url`     | a link button **Open in Holtkeeper**, in the last `actions` block when the card ends with one                                                                                            |

At most 50 blocks; `text` (the title, else the first text) is the notification fallback.

`formView(form, metadata)` builds a form modal (`callback_id` `FORM_VIEW`): `static_select` or `multi_static_select` for selects (100 options), `plain_text_input` for text, `checkboxes` with one box for toggles; `metadata` (3000 characters at most) comes back on submit. `formValues(form, state.values)` reads the submission back by field name.
