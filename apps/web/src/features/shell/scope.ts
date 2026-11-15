import { useCallback, useState } from 'react'

import { useTeamNames, usePreferences, useRepos } from '../../api/queries.ts'
import {
  type ScopedList,
  type ScopeView,
  parseScopeView,
  resolveScopeView,
  scopeList,
  viewTeam,
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
 * The viewer's scope switch position, remembered in this browser, and the home teams it filters
 * by. *My teams* until the viewer picks a position, or when the stored one is retired, names a
 * team the viewer can no longer see, or the repositories behind that check failed to load.
 */
export function useScope(): {
  view: ScopeView
  setView: (view: ScopeView) => void
  homeTeams: readonly string[]
  /**
   * The position and its home teams are known: preferences loaded for *My teams*, repositories
   * loaded for a team. Until then lists show a placeholder rather than empty or unscoped data.
   */
  ready: boolean
  /** *My teams* is on and the viewer has chosen no home teams: lists show `NoTeamsState`. */
  noTeams: boolean
  /** Splits a list of what the viewer may already see by its home teams. */
  scope: <T extends { teams: readonly string[] }>(items: readonly T[]) => ScopedList<T>
} {
  const preferences = usePreferences()
  const homeTeams = preferences.data?.homeTeams ?? []
  const repos = useRepos()
  const teams = useTeamNames()
  const [chosen, setChosen] = useState(readStored)
  const view = resolveScopeView(chosen, repos.isSuccess ? teams : repos.isError ? [] : undefined)
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
    homeTeams,
    ready:
      (viewTeam(view) === undefined || settled(repos)) && (view !== 'mine' || settled(preferences)),
    noTeams: view === 'mine' && preferences.isSuccess && !homeTeams.length,
    scope: (items) => scopeList(items, view, homeTeams),
  }
}
