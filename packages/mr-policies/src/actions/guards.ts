import type { ActionContext, ActionResult } from './provider.ts'

/** Why an action that changes the merge request cannot run now, or `undefined` when it can. */
export function notOpen(context: ActionContext): ActionResult | undefined {
  const { state } = context.event.mr
  return state === 'open' ? undefined : { status: 'skipped', detail: `merge request is ${state}` }
}

/** Refuses approvals and merges for policies whose scope does not cover the repository. */
export function outOfScope(context: ActionContext): ActionResult | undefined {
  return context.scopeCovers
    ? undefined
    : {
        status: 'skipped',
        detail: `policy ${context.policy.id} does not cover ${context.event.repo.path}`,
      }
}
