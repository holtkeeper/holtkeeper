import { type Action, type Principal, type RepoTarget, can } from '@holtkeeper/access'

/** Whether a listed repository-bound item is visible; lists filter instead of failing. */
export const canSee = (principal: Principal, action: Action, repo: RepoTarget) =>
  can(principal, action, { kind: 'repo', repo })
