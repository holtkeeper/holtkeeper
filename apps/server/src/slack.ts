import { type Action, scopeSchema } from '@holtkeeper/access'
import { type SlackClient, type SlackIdentity, slackClient } from '@holtkeeper/chat-slack'
import { resolveSecret } from '@holtkeeper/forge'
import { z } from 'zod'

import type { ServerDeps } from './context.ts'

const CONNECTION_KEY = 'chat:slack:connection'
const POLICY_KEY = 'chat:slack:policy'
const IDENTITY_TTL_MS = 10 * 60_000

/** Actions a channel binding may allow; commands outside them are refused in that channel. */
export const channelActions = [
  'releases:read',
  'releases:run',
  'analyses:read',
  'audits:read',
] as const satisfies readonly Action[]

const identitySchema = z.object({
  teamId: z.string(),
  team: z.string(),
  botUserId: z.string(),
  bot: z.string(),
  url: z.string().optional(),
})

const connectionSchema = z.object({
  botToken: z.string(),
  signingSecret: z.string(),
  identity: identitySchema,
  connectedAt: z.string(),
  connectedBy: z.string(),
})

/** What one Slack channel may do: the repositories and the actions commands there reach. */
const channelBindingSchema = z.object({
  channel: z.string().regex(/^[CG][A-Z0-9]+$/, 'expected a channel id like C0123ABCD'),
  name: z.string().trim().min(1).max(80),
  scope: scopeSchema,
  actions: z.array(z.enum(channelActions)).max(channelActions.length),
  /** `forge:path` commands use when they name no repository. */
  defaultRepo: z
    .string()
    .regex(/^[^:]+:.+$/, 'expected forge:path')
    .optional(),
})

/** Where the bot works: connected channels, and what happens elsewhere. */
export const slackPolicySchema = z.object({
  channels: z.array(channelBindingSchema).max(200).default([]),
  /** `deny`: commands in channels that are not connected are refused; `user`: the person's own grants apply. */
  unboundChannels: z.enum(['deny', 'user']).default('deny'),
  /** Commands in direct messages, with the person's own grants. */
  directMessages: z.boolean().default(true),
})

type SlackPolicy = z.infer<typeof slackPolicySchema>

/** Bot token and signing secret, as plaintext, and where they come from. */
interface SlackSecrets {
  botToken: string
  signingSecret: string
  source: 'file' | 'panel'
}

/** Bad Slack credentials or a refused connection; the message is for the person. */
export class SlackConnectionError extends Error {}

/**
 * The Slack app of a server. Its bot token and signing secret come from `chat.slack` of the config
 * file when set, else from the panel, where they are sealed with the vault in `store.kv`
 * (`chat:slack:connection`, with the workspace and bot `auth.test` reported). Channel bindings
 * and the policy for other channels and direct messages are panel settings (`chat:slack:policy`)
 * either way.
 */
function createSlackService(deps: ServerDeps) {
  const memory = new Map<string, unknown>()
  const kv = deps.store.kv ?? {
    get: async (key: string) => memory.get(key),
    set: async (key: string, value: unknown) => void memory.set(key, value),
    delete: async (key: string) => void memory.delete(key),
  }
  let fileIdentity: { at: number; identity: SlackIdentity | undefined } | undefined

  const stored = async () => {
    const parsed = connectionSchema.safeParse(await kv.get(CONNECTION_KEY))
    return parsed.success ? parsed.data : undefined
  }

  const secrets = async (): Promise<SlackSecrets | undefined> => {
    const file = deps.config.chat?.slack
    if (file)
      return {
        botToken: resolveSecret(file.botToken),
        signingSecret: resolveSecret(file.signingSecret),
        source: 'file',
      }
    const connection = await stored()
    if (!connection) return undefined
    return {
      botToken: await deps.vault.open(connection.botToken),
      signingSecret: await deps.vault.open(connection.signingSecret),
      source: 'panel',
    }
  }

  const clientFor = (token: () => string | Promise<string>): SlackClient =>
    slackClient({ token, ...(deps.slackFetch && { fetch: deps.slackFetch }) })

  /** A client whose token is read on every call, so a new connection applies at once. */
  const client = clientFor(async () => {
    const current = await secrets()
    if (!current) throw new SlackConnectionError('Slack is not connected')
    return current.botToken
  })

  const configured = async () =>
    deps.config.chat?.slack !== undefined || (await stored()) !== undefined

  /** The workspace and bot; for the file config asked from Slack and kept ten minutes. */
  const identity = async (): Promise<SlackIdentity | undefined> => {
    if (!deps.config.chat?.slack) return (await stored())?.identity
    const now = Date.now()
    if (fileIdentity && now - fileIdentity.at < IDENTITY_TTL_MS) return fileIdentity.identity
    const found = await client.identity().catch(() => undefined)
    fileIdentity = { at: now, identity: found }
    return found
  }

  const connect = async (
    input: { botToken: string; signingSecret: string },
    actor: string,
  ): Promise<SlackIdentity> => {
    if (deps.config.chat?.slack)
      throw new SlackConnectionError(
        'Slack is set in the config file (chat.slack); change it there',
      )
    if (!input.botToken.startsWith('xoxb-'))
      throw new SlackConnectionError('The bot token starts with xoxb- (Bot User OAuth Token)')
    let found: SlackIdentity
    try {
      found = await clientFor(() => input.botToken).identity()
    } catch (error) {
      throw new SlackConnectionError(
        `Slack refused the token: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await kv.set(CONNECTION_KEY, {
      botToken: await deps.vault.seal(input.botToken),
      signingSecret: await deps.vault.seal(input.signingSecret),
      identity: found,
      connectedAt: deps.now().toISOString(),
      connectedBy: actor,
    })
    return found
  }

  const disconnect = () => kv.delete(CONNECTION_KEY)

  const policy = async (): Promise<SlackPolicy> => {
    const parsed = slackPolicySchema.safeParse((await kv.get(POLICY_KEY)) ?? {})
    return parsed.success ? parsed.data : slackPolicySchema.parse({})
  }

  const savePolicy = (next: SlackPolicy) => kv.set(POLICY_KEY, next)

  const connection = async () => {
    const found = await stored()
    return found && { connectedAt: found.connectedAt, connectedBy: found.connectedBy }
  }

  return {
    secrets,
    client,
    configured,
    identity,
    connect,
    disconnect,
    policy,
    savePolicy,
    connection,
  }
}

export type SlackService = ReturnType<typeof createSlackService>

const services = new WeakMap<ServerDeps, SlackService>()

/** The one Slack app of a server, shared by the chat, the Slack routes and the panel. */
export function slackServiceFor(deps: ServerDeps): SlackService {
  let service = services.get(deps)
  if (!service) {
    service = createSlackService(deps)
    services.set(deps, service)
  }
  return service
}
