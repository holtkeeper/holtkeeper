import { type Grant, type GroupMatch, type Principal, groupMatchSchema } from '@holtkeeper/access'
import type { UserPreferences, UserPreferencesInput } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, principalOf, readBody } from '../context.ts'

interface StoredPreferences {
  homeGroups?: GroupMatch[]
}

const preferencesSchema = z.object({
  homeGroups: z.array(groupMatchSchema).max(100).nullable().optional(),
})

const keyOf = (principalId: string) => `prefs:${principalId}`

const matchKey = (entry: GroupMatch) => JSON.stringify(entry)

/** Every group entry of the grants' scopes, in grant order without duplicates. */
export function defaultHomeGroups(grants: readonly Grant[]): GroupMatch[] {
  const seen = new Map<string, GroupMatch>()
  for (const entry of grants.flatMap((grant) => grant.scope.groups ?? []))
    if (!seen.has(matchKey(entry))) seen.set(matchKey(entry), entry)
  return [...seen.values()]
}

function viewOf(stored: StoredPreferences | undefined, grants: readonly Grant[]): UserPreferences {
  return stored?.homeGroups
    ? { homeGroups: stored.homeGroups, homeGroupsFromGrants: false }
    : { homeGroups: defaultHomeGroups(grants), homeGroupsFromGrants: true }
}

const storedOf = (value: unknown): StoredPreferences | undefined => {
  const parsed = z.object({ homeGroups: z.array(groupMatchSchema).optional() }).safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** The principal's home groups: the ones it picked, else the groups in its grants. */
export async function homeGroupsOf(
  deps: Pick<ServerDeps, 'store'>,
  principal: Principal,
): Promise<GroupMatch[]> {
  return viewOf(storedOf(await deps.store.kv?.get(keyOf(principal.id))), principal.grants)
    .homeGroups
}

/** The signed-in principal's own UI preferences, kept in `Store.kv` under `prefs:<principal>`. */
export function preferenceRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  app.get('/me/preferences', async (c) => {
    const principal = principalOf(c)
    const stored = storedOf(await deps.store.kv?.get(keyOf(principal.id)))
    return c.json<UserPreferences>(viewOf(stored, principal.grants))
  })

  app.put('/me/preferences', async (c) => {
    const principal = principalOf(c)
    const kv = deps.store.kv
    if (!kv) throw new HTTPException(503, { message: 'this store keeps no preferences' })
    const input: UserPreferencesInput = await readBody(c, preferencesSchema)
    const previous = storedOf(await kv.get(keyOf(principal.id))) ?? {}
    const next: StoredPreferences = { ...previous }
    if (input.homeGroups === null) delete next.homeGroups
    else if (input.homeGroups !== undefined)
      next.homeGroups = [...new Map(input.homeGroups.map((e) => [matchKey(e), e])).values()]
    await kv.set(keyOf(principal.id), next)
    c.set('audit', {
      action: 'user.preferences',
      target: { type: 'user', id: principal.id },
      changes: [
        {
          field: 'homeGroups',
          ...(previous.homeGroups && { before: previous.homeGroups }),
          ...(next.homeGroups && { after: next.homeGroups }),
        },
      ],
    })
    return c.json<UserPreferences>(viewOf(next, principal.grants))
  })

  return app
}
