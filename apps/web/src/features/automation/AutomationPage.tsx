import { useNavigate, useSearch } from '@tanstack/react-router'

import { Page, Tabs } from '../../ui/index.ts'
import { RuntimeTab } from './RuntimeTab.tsx'
import { SchedulesTab } from './SchedulesTab.tsx'
import { TraitsTab } from './TraitsTab.tsx'
import { TriggersTab } from './TriggersTab.tsx'

const tabs = [
  { id: 'schedules', label: 'Schedules', content: <SchedulesTab /> },
  { id: 'triggers', label: 'Triggers', content: <TriggersTab /> },
  { id: 'traits', label: 'Repository traits', content: <TraitsTab /> },
  { id: 'runtime', label: 'Runtime', content: <RuntimeTab /> },
]

/** Schedules, triggers and repository traits edited over the config file, and its file-only parts. */
export function AutomationPage() {
  const search = useSearch({ from: '/app/automation' })
  const navigate = useNavigate({ from: '/automation' })
  const selected = tabs.some((t) => t.id === search.tab) ? search.tab : 'schedules'

  return (
    <Page
      title="Automation"
      description="What runs when. Panel changes are layered over holtkeeper.config.ts and take effect at once."
    >
      <Tabs
        aria-label="Automation sections"
        {...(selected ? { selected } : {})}
        onSelect={(tab) =>
          void navigate({ search: (previous) => ({ ...previous, tab }), replace: true })
        }
        items={tabs}
      />
    </Page>
  )
}
