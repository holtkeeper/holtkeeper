import type { Action } from '@holtkeeper/access'
import type { RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import { type Card, textCard } from './card.ts'
import {
  type ChatActor,
  type ChatAuthorization,
  type ChatCommand,
  type ChatCommandContext,
  ChatDeniedError,
  type ChatMessage,
  type ChatSurface,
  ChatUserError,
  liveMessage,
} from './command.ts'
import { type CommandLine, commandOptions, parseCommandLine } from './parse.ts'

/** What handling one message did. */
export interface ChatOutcome {
  status: 'ignored' | 'done' | 'unknown' | 'invalid' | 'denied' | 'failed'
  command?: string
  detail?: string
}

export interface ChatRouterOptions {
  /** Commands by name; a `help` command is added unless one is given. */
  commands: readonly ChatCommand<unknown>[]
  authorize(actor: ChatActor, action: Action, repo?: RepoRef): Promise<ChatAuthorization>
  /** The word after `/`. Default `holtkeeper`. */
  prefix?: string
  /** Unexpected command failures, after the person got a generic answer. */
  onError?(error: unknown, message: ChatMessage): void
}

/** Turns messages from any surface into command runs and answers them on that surface. */
export interface ChatRouter {
  readonly prefix: string
  readonly commands: readonly ChatCommand<unknown>[]
  /** The command of a message; `bare` also accepts a message starting with the command name. */
  parse(text: string, bare?: boolean): CommandLine | undefined
  /**
   * Runs the command of `message` (or `line`) and answers on `surface`: help for unknown
   * commands, usage for invalid arguments, what to do for refused actions, the message of a
   * `ChatUserError`. A message without a command is `ignored` and gets no answer. Never rejects
   * because of the command; only when the surface fails to post an answer.
   */
  handle(message: ChatMessage, surface: ChatSurface, line?: CommandLine): Promise<ChatOutcome>
}

const denialText = (action: Action, reason: string, prefix: string, actor: ChatActor) => {
  const where = actor.provider.split(':')[0] ?? actor.provider
  if (reason === 'not-linked')
    return `Your ${where} account is not linked to Holtkeeper. Link it under **Account → Linked accounts**${
      actor.externalId ? ` (provider \`${actor.provider}\`, id \`${actor.externalId}\`)` : ''
    }, then post \`/${prefix} verify <code>\` with the code shown there.`
  if (reason === 'unverified')
    return `Your linked ${where} account is not verified yet. Get a code under **Account → Linked accounts** and post \`/${prefix} verify <code>\`.`
  if (reason === 'no-principal') return 'The Holtkeeper user of your linked account is disabled.'
  return `You are not allowed to do this here (\`${action}\`).`
}

/** Builds the router for a set of commands. */
export function createChatRouter(options: ChatRouterOptions): ChatRouter {
  const prefix = options.prefix ?? 'holtkeeper'
  const byName = new Map<string, ChatCommand<unknown>>()

  const usageOf = (command: ChatCommand<unknown>) =>
    `/${prefix} ${command.name}${command.usage ? ` ${command.usage}` : ''}`

  const helpCard = (intro?: string): Card => ({
    title: 'Holtkeeper commands',
    blocks: [
      ...(intro ? [{ type: 'text' as const, text: intro }] : []),
      {
        type: 'list',
        items: [...byName.values()]
          .filter((command) => !command.hidden)
          .map((command) => ({ text: `\`${usageOf(command)}\` — ${command.summary}` })),
      },
    ],
  })

  const help: ChatCommand<unknown> = {
    name: 'help',
    summary: 'Lists the commands.',
    options: z.object({}).loose(),
    run: async (context) => void (await context.reply(helpCard())),
  }

  for (const command of options.commands) byName.set(command.name, command)
  if (!byName.has('help')) byName.set('help', help)

  const parse = (text: string, bare = false) => parseCommandLine(text, { prefix, bare })

  const handle = async (
    message: ChatMessage,
    surface: ChatSurface,
    given?: CommandLine,
  ): Promise<ChatOutcome> => {
    const line = given ?? parse(message.text)
    if (!line) return { status: 'ignored', detail: 'no command' }
    const say = async (card: Card) => liveMessage(surface, await surface.post(message.thread, card))

    const command = byName.get(line.name)
    if (!command) {
      await say(helpCard(`Unknown command \`${line.name}\`.`))
      return { status: 'unknown', command: line.name }
    }

    const parsed = command.options.safeParse(commandOptions(line.args, command.positional))
    if (!parsed.success) {
      await say(
        textCard(
          `Could not run ${command.name}`,
          `${z.prettifyError(parsed.error)}\n\nUsage: \`${usageOf(command)}\``,
          'warning',
        ),
      )
      return { status: 'invalid', command: command.name }
    }

    const context: ChatCommandContext<unknown> = {
      options: parsed.data,
      line,
      message,
      prefix,
      reply: say,
      require: async (action, repo) => {
        const result = await options.authorize(message.actor, action, repo)
        if (!result.allowed) throw new ChatDeniedError(action, result.reason)
        return result.principal
      },
    }

    try {
      await command.run(context)
      return { status: 'done', command: command.name }
    } catch (error) {
      if (error instanceof ChatDeniedError) {
        await say(
          textCard(
            'Not allowed',
            denialText(error.action, error.reason, prefix, message.actor),
            'warning',
          ),
        )
        return { status: 'denied', command: command.name, detail: error.reason }
      }
      if (error instanceof ChatUserError) {
        await say(error.card ?? textCard(`Could not run ${command.name}`, error.message, 'bad'))
        return { status: 'failed', command: command.name, detail: error.message }
      }
      options.onError?.(error, message)
      await say(
        textCard(`Could not run ${command.name}`, 'Something went wrong; it was logged.', 'bad'),
      )
      return {
        status: 'failed',
        command: command.name,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { prefix, commands: [...byName.values()], parse, handle }
}
