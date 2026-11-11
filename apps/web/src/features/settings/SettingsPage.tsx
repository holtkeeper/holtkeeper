import { useSearch } from '@tanstack/react-router'
import type { ComponentType } from 'react'

import { useSettings } from '../../api/queries.ts'
import {
  type SettingsTabId,
  advancedSettingKeys,
  settingsTabs,
  tabDefinitions,
} from '../../lib/settings-tabs.ts'
import { ErrorState, Page, Placeholder } from '../../ui/index.ts'
import { AiUsage } from '../ai/AiUsage.tsx'
import { Caches } from '../caches/Caches.tsx'
import { Credentials } from '../credentials/Credentials.tsx'
import { ForgesSection } from '../credentials/ForgesSection.tsx'
import { SlackTokensSection } from '../credentials/SlackTokensSection.tsx'
import { DatabaseHealth } from '../database/Database.tsx'
import { McpServer } from '../mcp/McpServer.tsx'
import { Forbidden } from '../shell/Forbidden.tsx'
import { visibleSettingsTabs } from '../shell/nav.ts'
import { useSession } from '../shell/session.ts'
import { Storage } from '../storage/Storage.tsx'
import { WriteTasksSection } from '../tasks/WriteTasksSection.tsx'
import { UserList } from '../users/Users.tsx'
import { LibraryIndex } from './LibraryIndex.tsx'
import { SettingEntries } from './SettingEntries.tsx'
import { SettingsSection } from './SettingsSection.tsx'

const settingTitles: Record<SettingsTabId, { title: string; description: string }> = {
  ai: {
    title: 'Provider and budget',
    description: 'Which credential agents use and what they may spend each week',
  },
  access: {
    title: 'Reach',
    description:
      "What other teams' repositories people and agents read, and read-only repositories",
  },
  integrations: {
    title: 'Trackers and webhooks',
    description: 'Issue trackers, release webhooks and request limits per credential',
  },
  system: {
    title: 'Background work',
    description:
      'Library index, polling, tool versions, freshness limits and settings without a page',
  },
}

/** The settings of one tab with their entries per scope; rarely changed ones fold under Advanced. */
function TabSettings({ tab }: { tab: SettingsTabId }) {
  const { can } = useSession()
  const settings = useSettings(can('settings:read'))
  if (!can('settings:read')) return null
  const { title, description } = settingTitles[tab]
  if (settings.isPending)
    return (
      <SettingsSection title={title} description={description}>
        <Placeholder className="h-40" />
      </SettingsSection>
    )
  if (settings.isError)
    return (
      <SettingsSection title={title} description={description}>
        <ErrorState error={settings.error} />
      </SettingsSection>
    )
  const definitions = tabDefinitions(settings.data.definitions, tab)
  if (!definitions.length) return null
  const main = definitions.filter((d) => !advancedSettingKeys.has(d.key))
  const advanced = definitions.filter((d) => advancedSettingKeys.has(d.key))
  return (
    <SettingsSection title={title} description={description}>
      {main.map((definition) => (
        <SettingEntries key={definition.key} data={settings.data} definition={definition} />
      ))}
      {advanced.length ? (
        <details className="group flex flex-col gap-4">
          <summary className="cursor-pointer text-sm text-muted hover:text-foreground">
            Advanced
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            {advanced.map((definition) => (
              <SettingEntries key={definition.key} data={settings.data} definition={definition} />
            ))}
          </div>
        </details>
      ) : null}
    </SettingsSection>
  )
}

function AiTab() {
  const { can } = useSession()
  return (
    <>
      <TabSettings tab="ai" />
      {can('credentials:read') ? <Credentials kinds="ai" /> : null}
      {can('ai:read') || can('ai:admin') ? <AiUsage /> : null}
    </>
  )
}

function AccessTab() {
  const { can } = useSession()
  return (
    <>
      {can('users:read') ? <UserList /> : null}
      <TabSettings tab="access" />
      <McpServer />
    </>
  )
}

function IntegrationsTab() {
  const { can } = useSession()
  return (
    <>
      <ForgesSection />
      {can('credentials:read') ? <Credentials kinds="other" /> : null}
      <TabSettings tab="integrations" />
      <SlackTokensSection />
    </>
  )
}

function SystemTab() {
  return (
    <>
      <Storage />
      <DatabaseHealth />
      <Caches />
      <LibraryIndex />
      <WriteTasksSection />
      <TabSettings tab="system" />
    </>
  )
}

const tabBodies: Record<SettingsTabId, ComponentType> = {
  ai: AiTab,
  access: AccessTab,
  integrations: IntegrationsTab,
  system: SystemTab,
}

/**
 * Settings as four tabs picked from the shell's top bar (`?tab=`): AI, Access, Integrations and
 * System, each only for principals the server lets read some of it. Settings owned by a page
 * (analyzer options, policies) are edited there instead.
 */
export function SettingsPage() {
  const { principal } = useSession()
  const search = useSearch({ from: '/app/settings' })
  const tabs = visibleSettingsTabs(principal)
  const tab = search.tab && tabs.includes(search.tab) ? search.tab : tabs[0]
  if (!tab)
    return (
      <Page title="Settings" icon="settings">
        <Forbidden />
      </Page>
    )
  const Body = tabBodies[tab]
  return (
    <Page
      title={settingsTabs[tab].label}
      eyebrow="Settings"
      icon="settings"
      description={settingsTabs[tab].description}
    >
      <div className="flex flex-col gap-8">
        <Body />
      </div>
    </Page>
  )
}
