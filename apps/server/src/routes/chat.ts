import type { ChatConversation } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { chatFor } from '../chat.ts'
import { type Env, type ServerDeps, parseRepo, principalOf, readBody } from '../context.ts'

const sendSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  repo: z.string().min(3).optional(),
})

/**
 * The panel chat of the signed-in person:
 *
 * - `GET /chat/messages` — the conversation (oldest first) and the commands for hints.
 * - `POST /chat/messages` `{ text, repo? }` — stores the text, runs it as a command (with or
 *   without the leading `/holtkeeper`) about `repo` when given, and answers with the conversation
 *   once the command answered. Actions are checked against the person's own grants.
 * - `DELETE /chat/messages` — forgets the conversation.
 *
 * Cards that follow a deploy are changed in place later; the page polls for them.
 */
export function chatRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  const conversation = async (userId: string): Promise<ChatConversation> => {
    const chat = chatFor(deps)
    return {
      messages: await chat.conversations.list(userId),
      commands: chat
        .router()
        .commands.filter((command) => !command.hidden && !['verify', 'link'].includes(command.name))
        .map((command) => ({
          name: command.name,
          summary: command.summary,
          ...(command.usage && { usage: command.usage }),
        })),
    }
  }

  app.get('/chat/messages', async (c) => c.json(await conversation(principalOf(c).id)))

  app.post('/chat/messages', async (c) => {
    const principal = principalOf(c)
    const input = await readBody(c, sendSchema)
    const repo = parseRepo(input.repo)
    const chat = chatFor(deps)
    const surface = chat.surface('web')
    if (!surface) throw new HTTPException(503, { message: 'the panel chat is not available' })
    await chat.conversations.append(principal.id, {
      from: 'user',
      text: input.text,
      ...(input.repo && { repo: input.repo }),
    })
    const router = chat.router([], { principal })
    const line = router.parse(input.text) ?? router.parse(input.text.replace(/^\//, ''), true)
    await router.handle(
      {
        surface: surface.id,
        thread: { user: principal.id, ...(input.repo && { repo: input.repo }) },
        actor: { provider: `panel:${principal.provider}`, externalId: principal.id },
        text: input.text,
        ...(repo && { repo }),
      },
      surface,
      line,
    )
    c.set('audit', { action: 'chat.message', target: { type: 'chat', id: principal.id } })
    return c.json(await conversation(principal.id))
  })

  app.delete('/chat/messages', async (c) => {
    const principal = principalOf(c)
    await chatFor(deps).conversations.clear(principal.id)
    return c.body(null, 204)
  })

  return app
}
