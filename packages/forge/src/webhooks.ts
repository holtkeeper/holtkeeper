/**
 * Every event a forge webhook can deliver, in GitLab's terms. Holtkeeper registers hooks for all
 * of them and decides per delivery whether it matters, so new triggers need no new registration.
 */
export const webhookEvents = [
  'push',
  'tag_push',
  'merge_request',
  'note',
  'confidential_note',
  'issues',
  'confidential_issues',
  'pipeline',
  'job',
  'deployment',
  'releases',
  'wiki_page',
  'milestone',
  'member',
  'emoji',
  'feature_flag',
  'resource_access_token',
] as const

/** One event a forge webhook can deliver. */
export type WebhookEvent = (typeof webhookEvents)[number]
