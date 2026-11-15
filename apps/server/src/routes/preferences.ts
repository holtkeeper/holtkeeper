import { type Principal, teamKeySchema, teamsOfPrincipal } from '@holtkeeper/access'
import type { UserPreferences, UserPreferencesInput } from '@holtkeeper/api'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, principalOf, readBody } from '../context.ts'

interface StoredPreferences {
  homeTeams?: string[]
}

const preferencesSchema = z.object({
  homeTeams: z.array(teamKeySchema).max(100).nullable().optional(),
})

const keyOf = (principalId: string) => `prefs:${principalId}`

/**
 * The home teams of a principal that never picked any: the configured teams it is a member of,
 * then the configured teams its grants name, without duplicates.
 */
export function defaultHomeTeams(
  teams: HoltkeeperConfig['teams'],
  principal: Pick<Principal, 'id' | 'email' | 'grants'>,
): string[] {
  const named = principal.grants.flatMap((grant) => grant.scope.teams ?? [])
  return [
    ...new Set([...teamsOfPrincipal(teams, principal), ...named.filter((team) => team in teams)]),
  ]
}

function viewOf(
  stored: StoredPreferences | undefined,
  teams: HoltkeeperConfig['teams'],
  principal: Principal,
): UserPreferences {
  return stored?.homeTeams
    ? { homeTeams: stored.homeTeams, homeTeamsFromMembership: false }
    : { homeTeams: defaultHomeTeams(teams, principal), homeTeamsFromMembership: true }
}

// Preferences stored before teams (`homeGroups`) do not parse as teams and fall back to the default.
const storedOf = (value: unknown): StoredPreferences | undefined => {
  const parsed = z.object({ homeTeams: z.array(z.string()).optional() }).safeParse(value)
  return parsed.success
    ? parsed.data.homeTeams
      ? { homeTeams: parsed.data.homeTeams }
      : {}
    : undefined
}

/** The principal's home teams: the ones it picked, else `defaultHomeTeams`. */
export async function homeTeamsOf(
  deps: Pick<ServerDeps, 'store' | 'config'>,
  principal: Principal,
): Promise<string[]> {
  return viewOf(
    storedOf(await deps.store.kv?.get(keyOf(principal.id))),
    deps.config.teams,
    principal,
  ).homeTeams
}

/** The signed-in principal's own UI preferences, kept in `Store.kv` under `prefs:<principal>`. */
export function preferenceRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  app.get('/me/preferences', async (c) => {
    const principal = principalOf(c)
    const stored = storedOf(await deps.store.kv?.get(keyOf(principal.id)))
    return c.json<UserPreferences>(viewOf(stored, deps.config.teams, principal))
  })

  app.put('/me/preferences', async (c) => {
    const principal = principalOf(c)
    const kv = deps.store.kv
    if (!kv) throw new HTTPException(503, { message: 'this store keeps no preferences' })
    const input: UserPreferencesInput = await readBody(c, preferencesSchema)
    const previous = storedOf(await kv.get(keyOf(principal.id))) ?? {}
    const next: StoredPreferences = { ...previous }
    if (input.homeTeams === null) delete next.homeTeams
    else if (input.homeTeams !== undefined) next.homeTeams = [...new Set(input.homeTeams)]
    await kv.set(keyOf(principal.id), next)
    c.set('audit', {
      action: 'user.preferences',
      target: { type: 'user', id: principal.id },
      changes: [
        {
          field: 'homeTeams',
          ...(previous.homeTeams && { before: previous.homeTeams }),
          ...(next.homeTeams && { after: next.homeTeams }),
        },
      ],
    })
    return c.json<UserPreferences>(viewOf(next, deps.config.teams, principal))
  })

  return app
}
