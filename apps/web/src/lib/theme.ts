/** What the viewer picked; `system` follows `prefers-color-scheme`. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** The theme actually applied for a preference and the system setting. */
export const resolveTheme = (preference: ThemePreference, systemDark: boolean): 'light' | 'dark' =>
  preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

/** Next preference when cycling the header toggle: system → light → dark → system. */
export const nextPreference = (preference: ThemePreference): ThemePreference =>
  preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system'

/** Reads a stored preference, ignoring anything unexpected. */
export const parsePreference = (value: string | null): ThemePreference =>
  value === 'light' || value === 'dark' ? value : 'system'
