import { CredentialsTable } from '../../credentials/CredentialsTable.tsx'
import { ForgesSection } from '../../credentials/ForgesSection.tsx'
import { ConfiguredTables, IntegrationsStrip } from '../../credentials/IntegrationTables.tsx'
import { SlackTokensSection } from '../../credentials/SlackTokensSection.tsx'
import { useSession } from '../../shell/session.ts'
import { SectionSettings } from '../SettingsSection.tsx'

/**
 * Settings › Integrations: a summary line, forges with their repositories and last webhook
 * delivery, the credentials table, configured trackers and request limits, the editors of those
 * settings and release webhooks, then the stored Slack tokens.
 */
export function IntegrationsSection() {
  const { can } = useSession()
  return (
    <>
      <IntegrationsStrip />
      <ForgesSection />
      {can('credentials:read') ? <CredentialsTable /> : null}
      <ConfiguredTables />
      <SectionSettings
        section="integrations"
        title="Trackers, release webhooks and limits"
        description="Edit the stored values per scope"
      />
      <SlackTokensSection />
    </>
  )
}
