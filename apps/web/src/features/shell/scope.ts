import type { GroupMatch } from '@holtkeeper/api'
import { useCallback, useState } from 'react'

import { usePreferences } from '../../api/queries.ts'
import {
  type ScopedList,
  type ScopeView,
  defaultScopeView,
  parseScopeView,
  scopeList,
} from '../../lib/home-scope.ts'

const storageKey = 'holtkeeper.scope'

function readStored(): ScopeView | undefined {
  try {
    return parseScopeView(localStorage.getItem(storageKey))
  } catch {
    return undefined
  }
}

/**
 * The viewer's scope switch position, remembered in this browser, and the home groups it filters
 * by. Until the viewer picks a position, or when the stored one is retired, *My teams* when it
 * has home groups, otherwise everything.
 */
export function useScope(): {
  view: ScopeView
  setView: (view: ScopeView) => void
  homeGroups: readonly GroupMatch[]
  /** Splits a list of what the viewer may already see by its home groups. */
  scope: <T extends { groups: readonly string[] }>(items: readonly T[]) => ScopedList<T>
} {
  const preferences = usePreferences()
  const homeGroups = preferences.data?.homeGroups ?? []
  const [chosen, setChosen] = useState(readStored)
  const view = chosen ?? (preferences.isPending ? 'all' : defaultScopeView(homeGroups))
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
    scope: (items) => scopeList(items, view, homeGroups),
  }
}
