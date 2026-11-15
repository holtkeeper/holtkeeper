import type { Principal } from '@holtkeeper/access'
import type { EmbeddingModelList, KnowledgeEmbeddingsStatus } from '@holtkeeper/api'
import { Hono } from 'hono'

import {
  type Env,
  type ServerDeps,
  ForbiddenException,
  authorize,
  principalOf,
} from '../context.ts'

const GLOBAL = { kind: 'global' } as const

const OFF: KnowledgeEmbeddingsStatus = { state: 'off', indexed: 0, total: 0 }

/** Whether the principal may read some knowledge at all. */
const readsKnowledge = (principal: Principal) =>
  principal.grants.some((grant) =>
    grant.actions.some((action) => action === '*' || action === 'knowledge:read'),
  )

/**
 * Semantic search admin (`knowledge.embeddings`): `GET /knowledge/embeddings` is the indexing
 * status (`knowledge:read` somewhere), `GET /knowledge/embeddings/models?credential=` the
 * embedding models of an `ai-sdk` credential and `POST /knowledge/embeddings/reindex` drops every
 * vector and embeds again (both a global `settings:write`). Mounted before the knowledge routes,
 * whose `/knowledge/:id` would take these paths.
 */
export function embeddingRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  app.get('/knowledge/embeddings', async (c) => {
    if (!readsKnowledge(principalOf(c))) throw new ForbiddenException('knowledge:read')
    return c.json<KnowledgeEmbeddingsStatus>((await deps.embeddings?.status()) ?? OFF)
  })

  app.get('/knowledge/embeddings/models', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const credential = c.req.query('credential')?.trim()
    if (!deps.embeddings)
      return c.json<EmbeddingModelList>({ models: [], error: 'semantic search is not available' })
    return c.json<EmbeddingModelList>(await deps.embeddings.models(credential || undefined))
  })

  app.post('/knowledge/embeddings/reindex', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const status = (await deps.embeddings?.reindex()) ?? OFF
    c.set('audit', {
      action: 'knowledge.reindex',
      target: { type: 'knowledge', id: 'embeddings' },
      details: { state: status.state, ...(status.model && { model: status.model }) },
    })
    return c.json<KnowledgeEmbeddingsStatus>(status)
  })

  return app
}
