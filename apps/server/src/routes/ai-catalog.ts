import { aiSdkPackages, isSupportedProvider } from '@holtkeeper/agent'
import type { AiCatalogProviderList, ProviderModelList } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { type Env, type ServerDeps, principalOf } from '../context.ts'

/**
 * The AI catalog for creating `ai-sdk` credentials: `GET /ai/providers` lists the providers
 * Holtkeeper can talk to (shipped AI SDK package, an `ai.providers` plugin or an OpenAI-compatible
 * API), `GET
 * /ai/providers/:id/models` one provider's models. Any signed-in caller may read it.
 */
export function aiCatalogRoutes({ aiCatalog, aiProviders = [] }: ServerDeps) {
  const app = new Hono<Env>()

  const providers = async () => {
    if (!aiCatalog) throw new Error('no AI catalog configured')
    return (await aiCatalog.providers()).filter((p) => isSupportedProvider(p, aiProviders))
  }

  app.get('/ai/providers', async (c) => {
    principalOf(c)
    const packages = aiSdkPackages(aiProviders)
    try {
      const list = await providers()
      return c.json<AiCatalogProviderList>({
        packages,
        providers: list
          .map((p) => ({
            id: p.id,
            name: p.name,
            package: packages.includes(p.package) ? p.package : '@ai-sdk/openai-compatible',
            ...(p.api && { api: p.api }),
            ...(p.doc && { doc: p.doc }),
            env: p.env,
            toolModels: p.models.filter((m) => m.toolCall).length,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      })
    } catch (error) {
      return c.json<AiCatalogProviderList>({
        packages,
        providers: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.get('/ai/providers/:id/models', async (c) => {
    principalOf(c)
    const provider = (await providers()).find((p) => p.id === c.req.param('id'))
    if (!provider) throw new HTTPException(404, { message: 'provider not in the catalog' })
    return c.json<ProviderModelList>({
      models: provider.models.map((m) => ({
        id: m.id,
        ...(m.name && { name: m.name }),
        ...(m.pricing && { pricing: m.pricing }),
        toolCall: m.toolCall,
        ...(m.contextWindow !== undefined && { contextWindow: m.contextWindow }),
        source: 'catalog',
      })),
    })
  })

  return app
}
