/** What the viewer picked; `system` follows `prefers-color-scheme`. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** The theme actually applied for a preference and the system setting. */
export const resolveTheme = (preference: ThemePreference, systemDark: boolean): 'light' | 'dark' =>
  preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

/** Next preference when cycling the header toggle: dark → light → system → dark. */
export const nextPreference = (preference: ThemePreference): ThemePreference =>
  preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark'

/** Reads a stored preference; anything missing or unexpected means the default, `dark`. */
export const parsePreference = (value: string | null): ThemePreference =>
  value === 'light' || value === 'system' ? value : 'dark'
