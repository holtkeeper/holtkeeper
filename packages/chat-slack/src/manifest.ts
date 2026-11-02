/** The request URLs a Slack app of this server needs. */
export interface SlackRequestUrls {
  events: string
  commands: string
  interactions: string
}

/** The request URLs under a server's public address. */
export function slackRequestUrls(baseUrl: string): SlackRequestUrls {
  const base = baseUrl.replace(/\/$/, '')
  return {
    events: `${base}/api/chat/slack/events`,
    commands: `${base}/api/chat/slack/commands`,
    interactions: `${base}/api/chat/slack/interactions`,
  }
}

/** Bot scopes the app asks for, and why. */
export const slackScopes: readonly { scope: string; why: string }[] = [
  { scope: 'chat:write', why: 'answer commands and post digests' },
  { scope: 'chat:write.public', why: 'post digests to public channels without an invite' },
  { scope: 'commands', why: 'the /holtkeeper slash command' },
  { scope: 'app_mentions:read', why: 'commands written as @holtkeeper …' },
  { scope: 'im:history', why: 'commands in direct messages' },
  { scope: 'channels:read', why: 'list public channels to connect' },
  { scope: 'groups:read', why: 'list private channels the bot was invited to' },
  { scope: 'users:read', why: 'show linked people by their Slack name' },
]

/**
 * A Slack app manifest for this server: a bot user, the `/holtkeeper` slash command, mentions and
 * direct messages as events and interactivity, all pointing at `baseUrl`.
 */
export function slackManifest(options: { baseUrl: string; name?: string }) {
  const urls = slackRequestUrls(options.baseUrl)
  const name = options.name ?? 'Holtkeeper'
  return {
    display_information: {
      name,
      description: 'Releases, digests and other Holtkeeper commands',
      background_color: '#1f2430',
    },
    features: {
      bot_user: {
        display_name: name.toLowerCase().replaceAll(/[^a-z0-9._-]/g, '-'),
        always_online: true,
      },
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      slash_commands: [
        {
          command: '/holtkeeper',
          url: urls.commands,
          description: 'Releases and other Holtkeeper commands',
          usage_hint: 'release repo=work:games/app-x',
          should_escape: false,
        },
      ],
    },
    oauth_config: { scopes: { bot: slackScopes.map((entry) => entry.scope) } },
    settings: {
      event_subscriptions: { request_url: urls.events, bot_events: ['app_mention', 'message.im'] },
      interactivity: { is_enabled: true, request_url: urls.interactions },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}

/** A link that opens Slack's "create an app" dialog with the manifest filled in. */
export const slackCreateAppUrl = (manifest: unknown) =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`
