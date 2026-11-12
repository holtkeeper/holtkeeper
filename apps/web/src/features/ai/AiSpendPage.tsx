import { canReadSpend } from '../../lib/access.ts'
import { Page } from '../../ui/index.ts'
import { Forbidden } from '../shell/Forbidden.tsx'
import { useSession } from '../shell/session.ts'
import { SpendPage } from './SpendPage.tsx'

/** Ops › AI spend (`/ops/spend`) for `ai:read` or `ai:admin`; others see why they cannot. */
export function AiSpendPage() {
  const { can } = useSession()
  if (canReadSpend(can)) return <SpendPage />
  return (
    <Page crumbs={[{ label: 'AI spend' }]}>
      <Forbidden missing={{ action: 'ai:read' }} />
    </Page>
  )
}
