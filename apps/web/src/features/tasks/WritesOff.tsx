import { Link } from '@tanstack/react-router'

import { useWriteTasks } from '../../api/queries.ts'
import { Notice } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

/**
 * Whether agent write tasks are switched off (`tasks.write`), so approving a task proposal would
 * fail; `false` while the status loads.
 */
export const useWritesOff = (enabled = true): boolean => {
  const status = useWriteTasks(enabled)
  return status.data?.enabled === false
}

/**
 * The warning shown next to task approvals while write tasks are off: approving fails until the
 * switch on Ops › Tasks is turned on, which needs `settings:write` over everything.
 */
export function WritesOffNotice() {
  const { canGlobal } = useSession()
  return (
    <Notice tone="warning" title="Agents may not change code yet">
      Approving a task fails while write tasks are off.{' '}
      {canGlobal('settings:read') ? (
        <>
          Turn them on with <b>Agents may change code</b> on{' '}
          <Link to="/ops/tasks" className="underline">
            Ops › Tasks
          </Link>
          {canGlobal('settings:write') ? '.' : ' (needs settings:write; ask an admin).'}
        </>
      ) : (
        'Ask an admin to turn them on in Ops › Tasks.'
      )}
    </Notice>
  )
}
