import { createHash, timingSafeEqual } from 'node:crypto'

import type { EgressRule, EgressRulesResponse } from '@holtkeeper/api'
import { resolveSecret } from '@holtkeeper/forge'
import { gitlabPackageRegistry } from '@holtkeeper/forge-gitlab'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import type { Env, ServerDeps } from '../context.ts'

const digest = (value: string) => createHash('sha256').update(value).digest()

const sameSecret = (given: string, expected: string) =>
  timingSafeEqual(digest(given), digest(expected))

/**
 * Egress proxy rules from the panel GitLab forges (all but those with `packages: false`): GET and
 * HEAD requests to their
 * package registries get `Authorization: Bearer <token>` with the forge credential's current token.
 * Forges whose credential cannot be read are left out.
 */
async function egressRules(
  deps: Pick<ServerDeps, 'store' | 'credentials'>,
  log: (line: string) => void = () => {},
): Promise<EgressRule[]> {
  const forges = (await deps.store.config?.list('forge')) ?? []
  const rules: EgressRule[] = []
  for (const forge of forges) {
    if (forge.data.packages === false || forge.data.kind !== 'gitlab') continue
    try {
      const token = await deps.credentials.reveal(forge.data.credentialId)
      rules.push({
        ...gitlabPackageRegistry(forge.data.url),
        methods: ['GET', 'HEAD'],
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch (error) {
      log(`egress: forge ${forge.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return rules
}

/**
 * `GET /egress/rules` for the egress proxy, which authenticates with `server.egress.secret` as a
 * bearer token. Not found when the config has no `server.egress`; no browser session grants it.
 */
export function egressRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  app.get('/egress/rules', async (c) => {
    const secret = deps.config.server?.egress?.secret
    if (!secret) throw new HTTPException(404, { message: 'not found' })
    const given = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim() ?? '')?.[1] ?? ''
    if (!sameSecret(given, resolveSecret(secret)))
      throw new HTTPException(401, { message: 'unauthorized' })
    c.header('cache-control', 'no-store')
    return c.json<EgressRulesResponse>({ rules: await egressRules(deps, console.error) })
  })
  return app
}
