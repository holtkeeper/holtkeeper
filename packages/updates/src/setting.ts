import { type DefaultSetting, defineSetting } from '@holtkeeper/settings'
import { z } from 'zod'

/** What polling looks for. */
export const pollEventKinds = ['mergeRequests', 'notes', 'pipelines', 'tags'] as const

export type PollEventKind = (typeof pollEventKinds)[number]

const intervalPattern = /^([1-9]\d*)(s|m|h|d)$/
const UNIT_MS = new Map([
  ['s', 1000],
  ['m', 60_000],
  ['h', 3_600_000],
  ['d', 86_400_000],
])

/** Shortest interval polling accepts. */
export const MIN_POLL_INTERVAL_MS = 30_000

/** Milliseconds of an interval such as `30s`, `5m`, `1h` or `1d`; `undefined` for other strings. */
export function intervalMs(value: string): number | undefined {
  const match = intervalPattern.exec(value)
  if (!match) return undefined
  const unit = UNIT_MS.get(match[2] ?? '')
  return unit === undefined ? undefined : Number(match[1]) * unit
}

const interval = z
  .string()
  .refine((value) => intervalPattern.test(value), 'expected an interval such as 30s, 5m or 1h')
  .refine(
    (value) => (intervalMs(value) ?? 0) >= MIN_POLL_INTERVAL_MS,
    'polling more often than every 30s is not allowed',
  )

export const pollingSchema = z.object({
  enabled: z.boolean(),
  /** How often to look for changes. */
  interval: interval.optional(),
  /** What to look for; everything when omitted. */
  events: z.array(z.enum(pollEventKinds)).min(1).optional(),
  /**
   * Interval while webhooks reach the repository, so polling only catches lost deliveries; `off`
   * stops polling then.
   */
  withWebhook: z.union([z.literal('off'), interval]).optional(),
})

export type PollingValue = z.infer<typeof pollingSchema>

/** A `polling` value with defaults applied. */
export interface PollingConfig {
  enabled: boolean
  intervalMs: number
  events: PollEventKind[]
  /** `undefined` stops polling while webhooks deliver. */
  withWebhookMs: number | undefined
}

const DEFAULT_POLL_INTERVAL = '5m'
const DEFAULT_WITH_WEBHOOK = '1h'

/** The effective polling config of a stored value; disabled when unset or invalid. */
export function pollingConfig(value: unknown): PollingConfig {
  const parsed = pollingSchema.safeParse(value)
  const data = parsed.success ? parsed.data : { enabled: false }
  const withWebhook = data.withWebhook ?? DEFAULT_WITH_WEBHOOK
  return {
    enabled: data.enabled,
    intervalMs: intervalMs(data.interval ?? DEFAULT_POLL_INTERVAL) ?? 300_000,
    events: data.events ?? [...pollEventKinds],
    withWebhookMs: withWebhook === 'off' ? undefined : intervalMs(withWebhook),
  }
}

/** Setting `polling` (section `Updates`): how Holtkeeper looks for forge changes on its own. */
export const pollingSetting = defineSetting({
  key: 'polling',
  label: 'Polling',
  description:
    'Look for merge request changes, comments, finished pipelines and tags on a schedule, for repositories webhooks do not reach.',
  section: 'Updates',
  help: `Polling finds the same changes a forge webhook delivers and reacts to them the same way: triggers, merge request policies and commands.

- **interval** is a target. Repositories sharing a forge token share its polling budget (\`pollShare\` of the token's \`requestsPerMinute\` in **Credential limits**, 20% by default); when the budget cannot keep up, every repository of that token is polled less often, evenly.
- **withWebhook** applies while webhooks reach the repository: polling then only catches lost deliveries. \`off\` stops it.
- Prefer a webhook where you can: it is instant and costs no requests.`,
  schema: pollingSchema,
  presets: [
    {
      id: 'webhook-first',
      label: 'Webhook first',
      description: 'Every 15 minutes, hourly once webhooks arrive.',
      value: { enabled: true, interval: '15m', withWebhook: '1h' },
    },
    {
      id: 'responsive',
      label: 'Responsive',
      description: 'Every minute; for a few repositories without webhooks.',
      value: { enabled: true, interval: '1m', withWebhook: '30m' },
    },
    {
      id: 'relaxed',
      label: 'Relaxed',
      description: 'Every 30 minutes, merge requests and tags only.',
      value: { enabled: true, interval: '30m', events: ['mergeRequests', 'tags'] },
    },
    {
      id: 'off',
      label: 'Off',
      description: 'Rely on webhooks only.',
      value: { enabled: false },
    },
  ],
})

/**
 * `polling` for every repository on a fresh install: every 5 minutes, hourly while webhooks
 * deliver, so repositories without webhooks react to changes without any setup.
 */
export const defaultPolling: DefaultSetting = {
  key: pollingSetting.key,
  value: { enabled: true, interval: '5m', withWebhook: '1h' } satisfies PollingValue,
}
