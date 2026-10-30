import { Monitor, Moon, Sun } from 'lucide-react'

import { nextPreference } from '../../lib/theme.ts'
import { Button, Tooltip, useTheme } from '../../ui/index.ts'

const labels = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' } as const

/** Cycles system → light → dark. */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme()
  const Icon = preference === 'system' ? Monitor : preference === 'light' ? Sun : Moon
  return (
    <Tooltip content={`${labels[preference]} (click to change)`}>
      <Button
        variant="ghost"
        isIconOnly
        aria-label={`${labels[preference]}, switch to ${labels[nextPreference(preference)].toLowerCase()}`}
        onPress={() => setPreference(nextPreference(preference))}
      >
        <Icon className="size-4" />
      </Button>
    </Tooltip>
  )
}
