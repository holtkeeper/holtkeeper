import type { Action, Principal } from '@holtkeeper/access'
import type { RepoRef } from '@holtkeeper/forge'
import type { z } from 'zod'

import type { Card } from './card.ts'
import type { CommandLine } from './parse.ts'

/** Who wrote a message, in the terms of the surface: `gitlab:work` user `42`. */
export interface ChatActor {
  /** Identity provider id, as `@holtkeeper/identities` names it. */
  provider: string
  /** The stable id there: e.g. a numeric forge user id. Never a username. */
  externalId: string
  username?: string
}

/** Where a conversation happens, in the surface's own terms; plain JSON so it can be stored. */
export type ChatThread = Record<string, string | number>

/** A message to Holtkeeper from any surface. */
export interface ChatMessage {
  /** Id of the surface that delivered it and answers it. */
  surface: string
  thread: ChatThread
  actor: ChatActor
  text: string
  /** The repository the conversation is about, when the surface knows it (a merge request). */
  repo?: RepoRef
  mergeRequest?: number
  headSha?: string
}

/** A message Holtkeeper posted; enough to change it later. */
export interface PostedMessage {
  surface: string
  thread: ChatThread
  /** Surface message id; absent when the surface cannot address its messages. */
  id?: string
}

/**
 * A place people talk to Holtkeeper: merge request notes, the web panel.
 * `post` resolves once the message is shown; `update` replaces a posted message in place, and
 * surfaces without it get a new message for every update.
 */
export interface ChatSurface {
  readonly id: string
  post(thread: ChatThread, card: Card): Promise<PostedMessage>
  update?(message: PostedMessage, card: Card): Promise<void>
}

/** A posted message that can still change, e.g. the status of a running deploy. */
export interface LiveMessage {
  readonly posted: PostedMessage
  update(card: Card): Promise<void>
}

/** A posted message as a `LiveMessage` of its surface. */
export function liveMessage(surface: ChatSurface, posted: PostedMessage): LiveMessage {
  let current = posted
  return {
    get posted() {
      return current
    },
    async update(card) {
      if (surface.update && current.id !== undefined) await surface.update(current, card)
      else current = await surface.post(current.thread, card)
    },
  }
}

/**
 * Whether an actor may perform an action. `reason` explains a refusal with the codes of
 * `@holtkeeper/identities` (`not-linked`, `unverified`, `no-principal`, `forbidden`).
 */
export type ChatAuthorization =
  | { allowed: true; principal: Principal }
  | { allowed: false; reason: string }

/** What a command gets to work with. */
export interface ChatCommandContext<Options> {
  options: Options
  line: CommandLine
  message: ChatMessage
  /** The `/holtkeeper` prefix of this router, for command lines shown to people. */
  prefix: string
  /** Posts a card in the conversation. */
  reply: (card: Card) => Promise<LiveMessage>
  /**
   * The actor's principal when they may perform `action` on `repo` (the whole system when absent);
   * otherwise throws `ChatDeniedError`, which the router answers.
   */
  require: (action: Action, repo?: RepoRef) => Promise<Principal>
}

/**
 * A command people run from any surface: `/holtkeeper <name> [args]`. Arguments become options
 * like this: `key=value` by name, `--flag` as `true`, the rest onto `positional` in order (the last
 * name takes the rest as a list). `options` validates them; failures are answered with usage.
 */
export interface ChatCommand<Options = Record<string, unknown>> {
  name: string
  /** One line for the help. */
  summary: string
  /** Arguments as shown in the help, e.g. `[step] [environment]`. */
  usage?: string
  positional?: string[]
  options: z.ZodType<Options>
  /** Left out of the help. */
  hidden?: boolean
  run(context: ChatCommandContext<Options>): Promise<void>
}

/** Declares a command; only for type inference. */
export const defineCommand = <Options>(command: ChatCommand<Options>): ChatCommand<Options> =>
  command

/** An action was refused; the router answers with what the actor can do about it. */
export class ChatDeniedError extends Error {
  readonly reason: string
  readonly action: Action

  constructor(action: Action, reason: string) {
    super(`${action}: ${reason}`)
    this.name = 'ChatDeniedError'
    this.action = action
    this.reason = reason
  }
}

/** A failure meant for the person: the router answers with its message (or `card`) as it is. */
export class ChatUserError extends Error {
  readonly card: Card | undefined

  constructor(message: string, card?: Card) {
    super(message)
    this.name = 'ChatUserError'
    this.card = card
  }
}
