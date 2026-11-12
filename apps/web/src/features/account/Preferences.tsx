import type { ScopeView } from '../../lib/home-scope.ts'
import type { ThemePreference } from '../../lib/theme.ts'
import { KeyValue, Panel, Segmented, useTheme } from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'

const themes: readonly { id: ThemePreference; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'System' },
]

const scopes: readonly { id: ScopeView; label: string }[] = [
  { id: 'mine', label: 'My teams' },
  { id: 'all', label: 'All I can see' },
]

/** Account › Preferences: the theme and the scope list pages open on, both kept in this browser. */
export function Preferences() {
  const { preference, setPreference } = useTheme()
  const { view, setView } = useScope()
  return (
    <Panel description="Kept in this browser.">
      <KeyValue
        labelWidth={140}
        rows={[
          {
            label: 'Theme',
            value: (
              <Segmented
                aria-label="Theme"
                options={themes}
                value={preference}
                onChange={setPreference}
              />
            ),
          },
          {
            label: 'Lists open on',
            value: (
              <Segmented
                aria-label="Default scope"
                options={scopes}
                value={view}
                onChange={setView}
              />
            ),
          },
        ]}
      />
    </Panel>
  )
}
