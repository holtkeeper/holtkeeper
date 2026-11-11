# @holtkeeper/notify

Sends short messages to people: a channel-independent `Notification`, a generic JSON webhook notifier, and the Slack mrkdwn text helpers `@holtkeeper/chat-slack` renders cards with.

## Contract

```ts
interface Notification {
  title: string
  text: string // markdown-ish: paragraphs, "- " lists, **bold**, `code`, [label](url), # headings
  url?: string // where to read more
  tone?: Tone
  fields?: { label: string; value: string }[]
}

interface Notifier {
  readonly name: string
  send(message: Notification): Promise<void> // resolves once the channel accepted it
}
```

`notificationSchema` (zod) validates notifications from outside, e.g. the API.

## Notifiers

`genericWebhook` takes `url: Secret` (a literal or `{ env }`, from `@holtkeeper/forge`) resolved on every send, and an injectable `fetch` and `sleep` for tests.

Delivery: one POST with `content-type: application/json`; on 429 or 5xx it waits `Retry-After` (1 s by default, at most 30 s) and retries once. Other failures reject with `<name>: HTTP <status>: <first 200 chars of the body>` or `<name>: request failed: <reason>`; the URL and header values are redacted from every message. Nothing is logged.

### `genericWebhook({ url, headers?, name? })`

POSTs the `Notification` itself as JSON. `headers` values are secrets too, e.g. `{ authorization: env('HOOK_TOKEN') }`; header names are lowercased.

## Slack text

`toMrkdwn` converts the markdown-ish text to Slack mrkdwn: `**bold**` → `*bold*`, headings → bold lines, list items → `•`, `[label](url)` → `<url|label>`. `&`, `<` and `>` are escaped everywhere, so text cannot mention `@channel` or users. `fit(text, max)` shortens text, cutting at a line break when it can and marking the cut with `…`; `slackLimits` holds the Block Kit limits (header 150, section 3000, field 2000, 10 fields per section, 20 fields, button 75, URL 3000).
