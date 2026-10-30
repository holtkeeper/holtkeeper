import { useCallback, useSyncExternalStore } from 'react'

import { type ThemePreference, parsePreference, resolveTheme } from '../lib/theme.ts'

const storageKey = 'holtkeeper.theme'
const query = '(prefers-color-scheme: dark)'
const listeners = new Set<() => void>()

function readPreference(): ThemePreference {
  try {
    return parsePreference(localStorage.getItem(storageKey))
  } catch {
    return 'system'
  }
}

let preference = readPreference()

function apply() {
  const theme = resolveTheme(preference, matchMedia(query).matches)
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(theme)
  root.dataset.theme = theme
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const media = matchMedia(query)
  const onChange = () => {
    apply()
    listener()
  }
  media.addEventListener('change', onChange)
  return () => {
    listeners.delete(listener)
    media.removeEventListener('change', onChange)
  }
}

const preferenceSnapshot = () => preference
const systemDarkSnapshot = () => matchMedia(query).matches

/** The viewer's theme preference and the resolved theme; `setPreference` persists the choice. */
export function useTheme(): {
  preference: ThemePreference
  theme: 'light' | 'dark'
  setPreference: (next: ThemePreference) => void
} {
  const current = useSyncExternalStore(subscribe, preferenceSnapshot)
  const systemDark = useSyncExternalStore(subscribe, systemDarkSnapshot)
  const setPreference = useCallback((next: ThemePreference) => {
    preference = next
    try {
      if (next === 'system') localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, next)
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
    apply()
    for (const listener of listeners) listener()
  }, [])
  return { preference: current, theme: resolveTheme(current, systemDark), setPreference }
}
