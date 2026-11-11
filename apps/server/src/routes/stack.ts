import type { StackOverview } from '@holtkeeper/api'
import { Hono } from 'hono'

import { type Env, type ServerDeps, principalOf, repoTarget } from '../context.ts'
import { stackGroupViews } from '../stack.ts'
import { canSee, catalogReach } from '../visibility.ts'

/**
 * `GET /stack`: the newest `stack` record of each config group, limited to the repositories in
 * the caller's catalog reach (`canSeeCatalog`), with uses judged at the record's time and a
 * comparison with the group's record from a week earlier. Convention diffs and fixes need
 * `analyses:read` on the repository. Reads stored records only.
 */
export function stackRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const targetOf = (repo: { forge: string; path: string }) => repoTarget(config, repo)
  const reach = catalogReach(store.settings, targetOf)

  app.get('/stack', async (c) => {
    const principal = principalOf(c)
    const { catalog } = await reach(principal)
    const groups = await stackGroupViews(
      store.analyses,
      {
        canRead: catalog,
        canFix: (repo) => canSee(principal, 'analyses:read', targetOf(repo)),
        groupsOf: (repo) => targetOf(repo).groups,
      },
      { compare: true },
    )
    return c.json<StackOverview>({ groups })
  })

  return app
}
