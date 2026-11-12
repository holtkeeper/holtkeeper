import type { Action, ForbiddenError, Grant } from '@holtkeeper/api'

import { actionLabels, actions } from './access.ts'

/** The missing permission of a 403, as `ForbiddenError` carries it. */
export type Missing = ForbiddenError['missing']

/** The card title for a refusal: `You can't run release steps`, or a plain one without details. */
export const forbiddenTitle = (missing: Missing | undefined): string =>
  missing ? `You can't ${actionLabels[missing.action]}` : 'No access'

/**
 * The actions the grants allow somewhere on the same kind of object as `action`
 * (`releases:read` for `releases:run`), in display order, `action` itself included when some grant
 * allows it on another scope. A grant with every action yields every one of that kind.
 */
export function relatedActions(grants: readonly Grant[], action: Action): Action[] {
  const kind = action.slice(0, action.indexOf(':'))
  const held = new Set(grants.flatMap((grant) => grant.actions))
  return actions.filter(
    (candidate) => candidate.startsWith(`${kind}:`) && (held.has('*') || held.has(candidate)),
  )
}

/**
 * A message asking an admin for the missing permission: who asks, what is missing, on what and
 * from which page. Holds only what the viewer already knows.
 */
export function accessRequest({
  missing,
  name,
  id,
  page,
}: {
  missing: Missing | undefined
  name: string
  id: string
  page: string
}): string {
  const what = missing
    ? `permission to ${actionLabels[missing.action]} (${missing.action})${
        missing.target ? ` on ${missing.target}` : ''
      }`
    : 'access to this page'
  return `Hi, could you give me ${what} in Holtkeeper? I am ${name} (${id}). Page: ${page}`
}
