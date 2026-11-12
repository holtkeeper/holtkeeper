import type { ThemePreference } from '../../lib/theme.ts'
import { KeyValue, Panel, ScopeSwitch, Segmented, useTheme } from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'

const themes: readonly { id: ThemePreference; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'System' },
]

/**
 * Account › Preferences: the theme and the scope list pages open on (*My teams*, *All I can see*
 * or one group), both kept in this browser.
 */
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
            value: <ScopeSwitch value={view} onChange={setView} />,
          },
        ]}
      />
    </Panel>
  )
}
