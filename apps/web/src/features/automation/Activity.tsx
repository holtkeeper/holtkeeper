import { useHistory } from '../../api/queries.ts'
import { AuditEventList } from '../audit-log/AuditEventList.tsx'

/**
 * Audit events about one rule (a schedule, trigger or setting entry), newest first, as the Audit
 * log shows them to the reader.
 */
export function TargetActivity({ type, id }: { type: string; id: string }) {
  const history = useHistory({ targetType: type, targetId: id }, true, 20)
  return <AuditEventList history={history} empty="No changes or runs recorded" />
}
