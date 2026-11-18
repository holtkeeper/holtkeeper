import { AgentToolsPanel, AiStrip, BudgetsPanel } from '../../ai/AiSettings.tsx'
import { Credentials } from '../../credentials/Credentials.tsx'
import { useSession } from '../../shell/session.ts'
import { SectionSettings } from '../SettingsSection.tsx'

/**
 * Settings › AI: a summary line, the AI provider cards, Budgets with the spend per feature and the
 * scoped caps, the provider and budget settings per scope, then the read-only agent tool registry.
 */
export function AiSection() {
  const { can } = useSession()
  const readAi = can('ai:read') || can('ai:admin')
  return (
    <>
      <AiStrip />
      {can('credentials:read') ? <Credentials /> : null}
      {readAi ? <BudgetsPanel /> : null}
      <SectionSettings
        section="ai"
        title="Provider and budget settings"
        description="Which credential agents use and the weekly budget per scope; a scoped budget is a cap"
      />
      {readAi ? <AgentToolsPanel /> : null}
    </>
  )
}
