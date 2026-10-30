# @holtkeeper/notify

Sends short messages about reports to people: a channel-independent `Notification`, a helper that builds one from any `Report`, and notifiers for Slack incoming webhooks and generic JSON webhooks.

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

## From a report

`reportNotification(report, url?, { metrics = 6, issues = 5 })`:

- title — `<report title>: <repo path> <ref>`;
- fields — the first metrics, formatted by unit (`formatMetricValue`) with their change (`formatDelta`), e.g. `1.5 kB (+512 B)`;
- text — `Compared with <ref>.` and the most severe issues (bad, warning, info; good and neutral are left out), relative links resolved against `url`;
- tone — the worst tone among metrics and listed issues.

## Notifiers

Both take `url: Secret` (a literal or `{ env }`, from `@holtkeeper/forge`) resolved on every send, and an injectable `fetch` and `sleep` for tests.

Delivery (shared): one POST with `content-type: application/json`; on 429 or 5xx it waits `Retry-After` (1 s by default, at most 30 s) and retries once. Other failures reject with `<name>: HTTP <status>: <first 200 chars of the body>` or `<name>: request failed: <reason>`; the URL and header values are redacted from every message. Nothing is logged.

### `slackWebhook({ url, button?, name? })`

Block Kit payload (`slackPayload`): a `header` (plain text, 150 chars), a `context` with the tone, a `section` with the text as mrkdwn (3000 chars), field `section`s (10 per section, at most 20 fields, 2000 chars each) and an `actions` button to `url` (omitted for URLs over 3000 chars). The top-level `text` is the title, for notifications. Long text is cut at a line break and marked with `…`.

`toMrkdwn` converts the markdown-ish text: `**bold**` → `*bold*`, headings → bold lines, list items → `•`, `[label](url)` → `<url|label>`. `&`, `<` and `>` are escaped everywhere (`escapeMrkdwn`), so a message cannot mention `@channel` or users.

### `genericWebhook({ url, headers?, name? })`

POSTs the `Notification` itself as JSON. `headers` values are secrets too, e.g. `{ authorization: env('HOOK_TOKEN') }`; header names are lowercased.
