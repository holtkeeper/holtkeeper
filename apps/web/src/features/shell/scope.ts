import type { GroupMatch } from '@holtkeeper/api'
import { useCallback, useState } from 'react'

import { useGroupNames, usePreferences, useRepos } from '../../api/queries.ts'
import {
  type ScopedList,
  type ScopeView,
  parseScopeView,
  resolveScopeView,
  scopeList,
  viewGroup,
} from '../../lib/home-scope.ts'

const storageKey = 'holtkeeper.scope'

function readStored(): ScopeView | undefined {
  try {
    return parseScopeView(localStorage.getItem(storageKey))
  } catch {
    return undefined
  }
}

const settled = (query: { isSuccess: boolean; isError: boolean }) =>
  query.isSuccess || query.isError

/**
 * The viewer's scope switch position, remembered in this browser, and the home groups it filters
 * by. *My teams* until the viewer picks a position, or when the stored one is retired, names a
 * group the viewer can no longer see, or the repositories behind that check failed to load.
 */
export function useScope(): {
  view: ScopeView
  setView: (view: ScopeView) => void
  homeGroups: readonly GroupMatch[]
  /**
   * The position and its home groups are known: preferences loaded for *My teams*, repositories
   * loaded for a group. Until then lists show a placeholder rather than empty or unscoped data.
   */
  ready: boolean
  /** *My teams* is on and the viewer has chosen no home groups: lists show `NoTeamsState`. */
  noTeams: boolean
  /** Splits a list of what the viewer may already see by its home groups. */
  scope: <T extends { groups: readonly string[] }>(items: readonly T[]) => ScopedList<T>
} {
  const preferences = usePreferences()
  const homeGroups = preferences.data?.homeGroups ?? []
  const repos = useRepos()
  const groups = useGroupNames()
  const [chosen, setChosen] = useState(readStored)
  const view = resolveScopeView(chosen, repos.isSuccess ? groups : repos.isError ? [] : undefined)
  const setView = useCallback((next: ScopeView) => {
    setChosen(next)
    try {
      localStorage.setItem(storageKey, next)
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
  }, [])
  return {
    view,
    setView,
    homeGroups,
    ready:
      (viewGroup(view) === undefined || settled(repos)) &&
      (view !== 'mine' || settled(preferences)),
    noTeams: view === 'mine' && preferences.isSuccess && !homeGroups.length,
    scope: (items) => scopeList(items, view, homeGroups),
  }
}
